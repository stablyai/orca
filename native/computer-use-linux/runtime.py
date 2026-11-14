#!/usr/bin/env python3
"""Orca Linux computer-use bridge.

The Node sidecar owns Orca's public API. This process is intentionally a small
AT-SPI adapter: read one JSON operation file, execute it in the user's desktop
session, and print one JSON response.
"""

import base64
from contextlib import contextmanager
import ctypes
import json
import math
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.parse
import uuid
from dataclasses import dataclass

try:
    import gi

    gi.require_version("Atspi", "2.0")
except (ImportError, ValueError) as error:
    # Why name it: PATH often puts a pyenv/Nix python3 without gi ahead of the system one.
    sys.stderr.write(f"PyGObject unavailable in interpreter: {sys.executable}\n{error}\n")
    sys.exit(1)
try:
    gi.require_version("Gdk", "3.0")
    from gi.repository import Gdk
except (ImportError, ValueError):
    Gdk = None
try:
    # Why separate: Wayland capture decodes grim's PNG with GdkPixbuf alone.
    gi.require_version("GdkPixbuf", "2.0")
    from gi.repository import GdkPixbuf
except (ImportError, ValueError):
    GdkPixbuf = None
from gi.repository import Atspi

try:
    # Why separate: KDE Wayland capture talks to KWin and the desktop portal over the session bus.
    from gi.repository import Gio, GLib
except ImportError:
    Gio = GLib = None

try:
    gi.require_version("GdkX11", "3.0")
    from gi.repository import GdkX11
except (ImportError, ValueError):
    GdkX11 = None

MAX_NODES = 1200
MAX_DEPTH = 64
TEXT_LIMIT = 500
MAX_SCREENSHOT_PNG_BYTES = 900_000
MAX_SCREENSHOT_EDGE = 1280
MIN_SCREENSHOT_SCALE = 0.25
SCREENSHOT_SCALE_STEP = 0.85
BLOCKED_APP_FRAGMENTS = (
    "1password",
    "bitwarden",
    "dashlane",
    "lastpass",
    "nordpass",
    "proton pass",
)
CLIPBOARD_COMMAND_TIMEOUT_SECONDS = 2
CLIPBOARD_OWNER_SETTLE_SECONDS = 0.05
CLIPBOARD_PASTE_SETTLE_SECONDS = 0.15
ATSPI_METHOD_TIMEOUT_MS = 800
ATSPI_STARTUP_TIMEOUT_MS = 15_000
GEOMETRY_BUDGET_SECONDS = 3
MIN_GEOMETRY_TIMEOUT_MS = 50


@dataclass
class Rect:
    x: float
    y: float
    width: float
    height: float

    def to_json(self):
        return {"x": self.x, "y": self.y, "width": self.width, "height": self.height}


def attempt(fn, fallback=None):
    try:
        value = fn()
        return fallback if value is None else value
    except Exception:
        return fallback


def ensure_desktop_bus():
    missing = [name for name in ("XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS") if not os.environ.get(name)]
    if missing:
        raise RuntimeError("Linux computer use requires an active desktop session; missing " + ", ".join(missing))


def desktop_root():
    return Atspi.get_desktop(0)


def children(node):
    count = int(attempt(node.get_child_count, 0) or 0)
    for index in range(count):
        child = attempt(lambda i=index: node.get_child_at_index(i))
        if child is not None:
            yield index, child


def text_attr(node, getter):
    return str(attempt(getter, "") or "")


def name_of(node):
    return text_attr(node, node.get_name)


def role_of(node):
    return text_attr(node, node.get_role_name)


def pid_of(node):
    return int(attempt(node.get_process_id, 0) or 0)


def has_state(node, state):
    return state_set_contains(attempt(node.get_state_set), state)


def state_set_contains(state_set, state, default=False):
    return bool(state_set is not None and attempt(lambda: state_set.contains(state), default))


class GeometryReader:
    def __init__(self):
        self.deadline = time.monotonic() + GEOMETRY_BUDGET_SECONDS

    def read(self, fn):
        remaining_ms = int((self.deadline - time.monotonic()) * 1000)
        if remaining_ms < MIN_GEOMETRY_TIMEOUT_MS:
            return None
        Atspi.set_timeout(min(ATSPI_METHOD_TIMEOUT_MS, remaining_ms), -1)
        try:
            return attempt(fn)
        finally:
            Atspi.set_timeout(ATSPI_METHOD_TIMEOUT_MS, ATSPI_STARTUP_TIMEOUT_MS)


def screen_rect(node, read=attempt):
    return extents_rect(node, Atspi.CoordType.SCREEN, read)


def extents_rect(node, coord_type, read=attempt):
    component = read(node.get_component_iface)
    if component is None:
        return None
    rect = read(lambda: Atspi.Component.get_extents(component, coord_type))
    if rect is None or rect.width <= 0 or rect.height <= 0:
        return None
    return Rect(float(rect.x), float(rect.y), float(rect.width), float(rect.height))


UNREAD = object()


class Placement:
    """Screen and window-relative rectangles for one window's nodes.

    GTK 4 reports SCREEN extents of [0, 0, w, h] for nearly every node, so its rectangles come from WINDOW
    extents plus the X11 client origin (agent-desktop probes/linux/FINDINGS.md L23-37).
    """

    def __init__(self, app, window):
        self.app, self.window = app, window
        self.base = self._origin = UNREAD
        self.window_coords = toolkit_kind(app) == "gtk4"

    @property
    def origin(self):
        if self._origin is UNREAD:
            self._origin = (gtk4_client_origin(self.app, self.window)
                            if self.window_coords and not wayland_session() else None)
        return self._origin

    def screen(self, node, read=attempt):
        if not self.window_coords:
            return screen_rect(node, read)
        rect = extents_rect(node, Atspi.CoordType.WINDOW, read) if self.origin is not None else None
        return None if rect is None else Rect(rect.x + self.origin[0], rect.y + self.origin[1], rect.width, rect.height)

    def bounds(self):
        if self.window_coords and wayland_session():
            # Why: Wayland capture finds the window through the compositor and only checks its size.
            return screen_rect(self.window)
        return self.screen(self.window)

    def frame(self, node, read=attempt):
        coord_type = Atspi.CoordType.WINDOW if self.window_coords else Atspi.CoordType.SCREEN
        if self.base is UNREAD:
            self.base = extents_rect(self.window, coord_type, read)
        rect = self.base if node is self.window else extents_rect(node, coord_type, read)
        if rect is None or self.base is None:
            return None
        return Rect(rect.x - self.base.x, rect.y - self.base.y, rect.width, rect.height)


# Why per operation: list-windows places every window of an app, and each lookup is a subprocess.
_x11_windows_by_pid = {}


def gtk4_client_origin(app, window):
    xdotool = shutil.which("xdotool")
    if not xdotool:
        return None
    pid = pid_of(app)
    if pid not in _x11_windows_by_pid:
        ids = x11_window_ids(app, xdotool) or []
        _x11_windows_by_pid[pid] = [(value, x11_window_name(xdotool, value) if len(ids) > 1 else None) for value in ids]
    windows = _x11_windows_by_pid[pid]
    if len(windows) > 1:
        title = name_of(window)
        windows = [item for item in windows if item[1] == title]
    return x11_client_origin(int(windows[0][0])) if len(windows) == 1 else None


def x11_window_name(xdotool, window_id):
    try:
        result = subprocess.run([xdotool, "getwindowname", window_id], check=False, capture_output=True,
                                text=True, timeout=2)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.rstrip("\n") if result.returncode == 0 else None


def desktop_apps():
    for _, app in children(desktop_root()):
        if name_of(app):
            yield app


def windows_for(app):
    result = []
    for index, child in children(app):
        role = role_of(child).lower()
        standard_role = role in {"frame", "window", "dialog", "alert"}
        if standard_role or screen_rect(child) is not None:
            result.append((index, child))
    return result


def choose_window(app, window_id=None, window_index=None):
    windows = windows_for(app)
    if not windows:
        raise RuntimeError("No top-level AT-SPI window is available for " + name_of(app))
    if window_id is not None:
        raise RuntimeError("windowId is not supported by the Linux AT-SPI provider; use windowIndex")
    if window_index is not None:
        for item in windows:
            if item[0] == int(window_index):
                return item
        raise RuntimeError(f'windowNotFound("{window_index}")')
    for item in windows:
        if has_state(item[1], Atspi.StateType.ACTIVE):
            return item
    for item in windows:
        if has_state(item[1], Atspi.StateType.SHOWING):
            return item
    return windows[0]


RESTORE_HINT = "Ask the user before retrying with --restore-window."
# Shift, Control, Mod1 (Alt), Mod4 (Super) and Mod5 (AltGr); Lock and NumLock are toggles, not held keys.
HELD_MODIFIER_MASK = 0x1 | 0x4 | 0x8 | 0x40 | 0x80
LOCK_MASK = 0x2
ALL_DESKTOPS = {-1, 0xFFFFFFFF}


def restore_window(app, window=None):
    target = window if window is not None else choose_window(app)[1]
    if has_state(target, Atspi.StateType.ACTIVE):
        return
    xdotool = None if wayland_session() else shutil.which("xdotool")
    ids = x11_window_ids(app, xdotool) if xdotool else None
    if ids:
        windows = windows_for(app)
        single = len(ids) == 1 and len(windows) == 1 and windows[0][1] == target
        # Why every id when the target can't be told apart: GrabFocus would also switch to its workspace.
        refuse_other_desktop(xdotool, ids)
        if single:
            attempt(lambda: subprocess.run([xdotool, "windowactivate", "--sync", ids[0]], check=False,
                                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2))
            if wait_window_focused(target):
                return
    # Why last: GrabFocus is unsupported on GTK4 and only sometimes activates GTK3 windows (agent-desktop L4-16).
    component = attempt(target.get_component_iface)
    if component is not None:
        attempt(lambda: Atspi.Component.grab_focus(component), False)
    wait_window_focused(target)


def x11_window_ids(app, xdotool):
    """The managed X11 windows the app's process owns, or None when they can't be read."""
    pid = pid_of(app)
    if not pid:
        return None
    try:
        result = subprocess.run([xdotool, "search", "--pid", str(pid)],
                                check=False, capture_output=True, text=True, timeout=2)
    except (OSError, subprocess.TimeoutExpired):
        return None
    ids = result.stdout.split()
    if result.returncode != 0 or any(not value.isdigit() or int(value) <= 0 for value in ids):
        return None
    managed_ids = attempt(lambda: {str(GdkX11.X11Window.get_xid(item))
                                  for item in Gdk.Screen.get_default().get_window_stack()})
    if managed_ids is None or any(not value.isdigit() or int(value) <= 0 for value in managed_ids):
        return None
    return [value for value in ids if value in managed_ids]


def refuse_other_desktop(xdotool, window_ids):
    def desktop(*command):
        try:
            result = subprocess.run([xdotool, *command], check=False, capture_output=True, text=True, timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            return None
        value = result.stdout.strip()
        return int(value) if result.returncode == 0 and re.fullmatch(r"-?\d+", value) else None

    current = desktop("get_desktop")
    if current is None:
        return
    # Why: activating a window on another desktop switches the user's whole view there; with desktops in use, an
    # unreadable one can't be shown safe.
    if any(target is None or target not in ALL_DESKTOPS and target != current
           for target in (desktop("get_desktop_for_window", window_id) for window_id in window_ids)):
        raise RuntimeError("background_unavailable: a window of this app is on another workspace (or its workspace "
                           "can't be read), and raising the target could switch the user's view there; nothing was sent. Ask the user to move it to "
                           "the current workspace or switch there themselves")


def any_window_active(app):
    return any(has_state(window, Atspi.StateType.ACTIVE) for _, window in windows_for(app))


def wait_window_focused(window):
    deadline = time.monotonic() + 0.5
    while time.monotonic() < deadline:
        if has_state(window, Atspi.StateType.ACTIVE):
            return True
        time.sleep(0.05)
    return has_state(window, Atspi.StateType.ACTIVE)


def refuse_wayland_input(what):
    # Why: XTest never reaches native Wayland windows (agent-desktop L13-14, L13-17), so it would report a false success.
    if wayland_session():
        raise RuntimeError(f"unsupported capability: {what} on Wayland: native Wayland windows ignore synthetic input, "
                           "so nothing was sent. Use click --element-index, set-value or type-text --element-index")


def require_keyboard_focus(app, window, operation, verb):
    refuse_wayland_input(verb)
    if has_state(window, Atspi.StateType.ACTIVE):
        return
    if operation.get("restoreWindow"):
        restore_window(app, window)
        if wait_window_focused(window):
            return
        raise RuntimeError("window_not_focused: keyboard input requires the target window to be focused; restoreWindow was requested but the target window is still not focused, so nothing was sent; ask the user to bring it forward or check desktop permissions")
    raise RuntimeError(f"background_unavailable: {verb} sends keys to the focused window, and the target window is "
                       "not focused; nothing was sent. To enter text use type-text --element-index or set-value, "
                       f"which work in the background. {RESTORE_HINT}")


def require_pointer_route(operation, what, hint):
    refuse_wayland_input(what)
    if not operation.get("restoreWindow"):
        advice = " ".join(part for part in (hint, RESTORE_HINT) if part)
        raise RuntimeError(f"background_unavailable: {what} needs the real pointer, which would raise the target "
                           f"window and move the user's cursor; nothing was sent. {advice}")


def restore_pointer_window(app, window):
    restore_window(app, window)
    if not wait_window_focused(window):
        raise RuntimeError("window_not_focused: window restoration did not focus the target window; no pointer input was sent")


X11_WINDOW = ctypes.c_ulong
X11_ERROR_HANDLER = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)
# Why kept: Xlib's default handler exits the process on a BadWindow from a window that closed mid-read.
_ignore_x11_errors = X11_ERROR_HANDLER(lambda _display, _event: 0)


@contextmanager
def x11_display():
    """libX11 and an open display, or (None, None) when no X11 display answers."""
    try:
        x = ctypes.CDLL("libX11.so.6")
    except OSError:
        yield None, None
        return
    pointer, window, integer = ctypes.c_void_p, X11_WINDOW, ctypes.c_int
    for name, result, args in (
        ("XOpenDisplay", pointer, [ctypes.c_char_p]),
        ("XCloseDisplay", integer, [pointer]),
        ("XSetErrorHandler", X11_ERROR_HANDLER, [X11_ERROR_HANDLER]),
        ("XDefaultRootWindow", window, [pointer]),
        ("XQueryPointer", integer, [pointer, window, ctypes.POINTER(window), ctypes.POINTER(window),
                                    *[ctypes.POINTER(integer)] * 4, ctypes.POINTER(ctypes.c_uint)]),
        ("XTranslateCoordinates", integer, [pointer, window, window, integer, integer, ctypes.POINTER(integer),
                                            ctypes.POINTER(integer), ctypes.POINTER(window)]),
        ("XInternAtom", ctypes.c_ulong, [pointer, ctypes.c_char_p, integer]),
        ("XGetWindowProperty", integer, [pointer, window, ctypes.c_ulong, ctypes.c_long, ctypes.c_long, integer,
                                         ctypes.c_ulong, ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(integer),
                                         ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
                                         ctypes.POINTER(ctypes.POINTER(ctypes.c_long))]),
        ("XFree", integer, [pointer]),
    ):
        fn = getattr(x, name)
        fn.restype, fn.argtypes = result, args
    display = x.XOpenDisplay(None)
    if not display:
        yield None, None
        return
    previous = x.XSetErrorHandler(_ignore_x11_errors)
    try:
        yield x, display
    finally:
        x.XCloseDisplay(display)
        x.XSetErrorHandler(previous)


def x11_pointer_state():
    """The X11 pointer's root position (None off the default screen) and modifier mask, or None with no X11 display."""
    with x11_display() as (x, display):
        if display is None:
            return None
        root, child = X11_WINDOW(), X11_WINDOW()
        root_x, root_y, window_x, window_y = (ctypes.c_int() for _ in range(4))
        mask = ctypes.c_uint()
        # Why keep the mask on False: that only means the pointer is on another screen; the modifiers are still valid.
        if not x.XQueryPointer(display, x.XDefaultRootWindow(display), ctypes.byref(root), ctypes.byref(child),
                               ctypes.byref(root_x), ctypes.byref(root_y), ctypes.byref(window_x),
                               ctypes.byref(window_y), ctypes.byref(mask)):
            return None, None, mask.value
        return root_x.value, root_y.value, mask.value


def x11_client_origin(window_id):
    """Where the visible area of an X11 client window starts on the root: its origin plus its client-side shadow."""
    with x11_display() as (x, display):
        if display is None:
            return None
        root_x, root_y, child = ctypes.c_int(), ctypes.c_int(), X11_WINDOW()
        if not x.XTranslateCoordinates(display, window_id, x.XDefaultRootWindow(display), 0, 0,
                                       ctypes.byref(root_x), ctypes.byref(root_y), ctypes.byref(child)):
            return None
        shadow = (0, 0)
        atom = x.XInternAtom(display, b"_GTK_FRAME_EXTENTS", 1)
        actual_type, actual_format = ctypes.c_ulong(), ctypes.c_int()
        count, remaining, data = ctypes.c_ulong(), ctypes.c_ulong(), ctypes.POINTER(ctypes.c_long)()
        if atom and x.XGetWindowProperty(display, window_id, atom, 0, 4, 0, 6, ctypes.byref(actual_type),
                                         ctypes.byref(actual_format), ctypes.byref(count), ctypes.byref(remaining),
                                         ctypes.byref(data)) == 0 and data:
            try:
                if actual_format.value == 32 and count.value == 4:
                    shadow = (int(data[0]), int(data[2]))  # left, right, top, bottom
            finally:
                x.XFree(data)
        return root_x.value + shadow[0], root_y.value + shadow[1]


@contextmanager
def pointer_put_back():
    before = x11_pointer_state()
    try:
        yield
    finally:
        if before is not None and before[0] is not None:
            attempt(lambda: Atspi.generate_mouse_event(before[0], before[1], "abs"))


def require_idle_keyboard():
    state = x11_pointer_state()
    if state is not None and state[2] & HELD_MODIFIER_MASK:
        raise RuntimeError("unsupported capability: a modifier key (Shift, Ctrl, Alt or Super) is held down and would "
                           "combine with synthetic keys; nothing was sent. Retry when no keys are held")
    return None if state is None else state[2]


def app_matches(app, query):
    needle = str(query or "").strip().lower()
    if not needle:
        return False
    if needle.startswith("pid:"):
        requested_pid = parse_positive_pid(needle[4:])
        return requested_pid is not None and pid_of(app) == requested_pid
    if needle.isdigit() and int(needle) > 0 and pid_of(app) == int(needle):
        return True
    haystacks = [name_of(app).lower()] + [name_of(window).lower() for _, window in windows_for(app)]
    return any(value == needle or needle in value for value in haystacks)


def parse_positive_pid(value):
    return int(value) if value.isdigit() and int(value) > 0 else None


def find_app(query):
    for app in desktop_apps():
        if app_matches(app, query):
            reject_blocked_app(app)
            return app
    raise RuntimeError(f'appNotFound("{query}")')


def reject_blocked_app(app):
    haystacks = [name_of(app).lower()] + [name_of(window).lower() for _, window in windows_for(app)]
    if any(fragment in value for fragment in BLOCKED_APP_FRAGMENTS for value in haystacks):
        raise RuntimeError(f'appBlocked("{name_of(app)}")')


def action_labels(node):
    labels = []
    count = int(attempt(node.get_n_actions, 0) or 0)
    for index in range(count):
        label = str(attempt(lambda i=index: node.get_action_name(i), "") or "")
        description = str(attempt(lambda i=index: node.get_action_description(i), "") or "")
        value = label or description
        if value and value not in labels:
            labels.append(value)
    return labels


def meaningful_actions(actions):
    noisy = {
        "click",
        "press",
        "show default ui",
        "show alternate ui",
        "show menu",
        "scroll to visible",
        "raise",
    }
    return [action for action in actions if action.strip().lower() not in noisy]


def display_action(action):
    value = str(action or "").strip()
    if not value:
        return value
    return " ".join(value.replace("_", " ").split())


def sanitize_text(value):
    return " ".join(str(value or "").replace("\r", " ").replace("\n", " ").split())


def formatted_value(role_key, title, value):
    clean = sanitize_text(value)
    if not clean or clean == title:
        return ""
    if role_key in {"label", "static", "static text", "text", "entry", "text entry"}:
        return " " + clean
    return ", Value: " + clean


def suppress_children(role_key, title, value, summary):
    has_compact_label = bool(title or sanitize_text(value) or sanitize_text(summary))
    return has_compact_label and role_key in {
        "button",
        "check box",
        "checkbox",
        "combo box",
        "heading",
        "link",
        "menu item",
        "page tab",
        "push button",
        "radio button",
    }


def text_iface(node):
    return attempt(lambda: node.get_text_iface())


def is_text_node(node):
    result = attempt(lambda: node.is_text())
    return bool(result) if result is not None else text_iface(node) is not None


def string_value(node):
    if is_secure_node(node):
        return "[redacted]"
    if is_text_node(node):
        iface = text_iface(node)
        count = int(attempt(lambda: Atspi.Text.get_character_count(iface), 0) or 0)
        if iface is not None and count > 0:
            value = str(attempt(lambda: Atspi.Text.get_text(iface, 0, min(count, TEXT_LIMIT)), "") or "")
            return value + ("..." if count > TEXT_LIMIT else "")
    value_iface = attempt(node.get_value_iface)
    if value_iface is not None:
        current = attempt(lambda: Atspi.Value.get_current_value(value_iface))
        if current is not None:
            return str(current)
    return ""


def is_secure_node(node):
    role = role_of(node).lower()
    label = " ".join([role, name_of(node).lower(), accessible_id(node).lower()])
    sensitive_terms = ("password", "passcode", "secret", "one-time code", "verification code")
    if any(term in label for term in sensitive_terms) or re.search(r"(^|[^a-z0-9])pin([^a-z0-9]|$)", label):
        return True
    state_set = attempt(node.get_state_set)
    protected_state = getattr(Atspi.StateType, "PROTECTED", None)
    if state_set is not None and protected_state is not None and attempt(lambda: state_set.contains(protected_state), False):
        return True
    return False


def accessible_id(node):
    return str(attempt(node.get_accessible_id, "") or "")


def is_disabled(state_set):
    # Why: toolkits set ENABLED and SENSITIVE on usable nodes; a node whose states can't be read is not called disabled.
    usable = [getattr(Atspi.StateType, name, None) for name in ("ENABLED", "SENSITIVE")]
    if state_set is None or None in usable:
        return False
    return not any(state_set_contains(state_set, state, True) for state in usable)


def record(node, index, path):
    role = role_of(node)
    state_set = attempt(node.get_state_set)
    return {
        "index": index,
        "runtimeId": path,
        "automationId": accessible_id(node),
        "name": name_of(node),
        "controlType": role,
        "localizedControlType": role,
        "className": str(attempt(node.get_toolkit_name, "") or ""),
        "value": string_value(node),
        "isSelected": state_set_contains(state_set, Atspi.StateType.SELECTED),
        "isDisabled": is_disabled(state_set),
        "nativeWindowHandle": 0,
        "frame": None,
        "actions": action_labels(node),
    }


def render_accessibility_tree(root, root_path, compact_browser_tabs=False, geometry_nodes=None):
    records = []
    lines = []
    truncation = {"truncated": False, "maxNodes": MAX_NODES, "maxDepth": MAX_DEPTH, "maxDepthReached": False}
    # Tab compaction shrinks records mid-walk, so len(records) would reuse retained indexes.
    next_index = 0

    def text_snippets(node, limit=6, max_depth=3):
        values = []
        seen = set()

        def collect(candidate, depth):
            if len(values) >= limit or depth > max_depth:
                return
            role = role_of(candidate).lower()
            if role in {"label", "static", "static text", "text", "link"}:
                for raw in (name_of(candidate), string_value(candidate)):
                    value = " ".join(str(raw or "").split())
                    if value and value not in seen:
                        seen.add(value)
                        values.append(value[:80])
                        if len(values) >= limit:
                            return
            for _, child in children(candidate):
                collect(child, depth + 1)
                if len(values) >= limit:
                    return

        collect(node, 0)
        return values

    def is_plain_text_subtree(node, max_depth=4):
        saw_text = False
        allowed = {"panel", "filler", "unknown", "section", "label", "static", "static text", "text", "link", "image"}

        def visit(candidate, depth):
            nonlocal saw_text
            if depth > max_depth:
                return False
            role = role_of(candidate).lower()
            if role not in allowed:
                return False
            if role in {"label", "static", "static text", "text", "link"}:
                saw_text = True
            if meaningful_actions(action_labels(candidate)):
                return False
            return all(visit(child, depth + 1) for _, child in children(candidate))

        return visit(node, 0) and saw_text

    def should_elide(item, child_count, summary):
        role = (item["controlType"] or "").lower()
        has_text = bool(item["name"] or item["automationId"] or item["value"])
        return role in {"panel", "filler", "unknown", "section"} and not has_text and not meaningful_actions(item["actions"]) and summary is None and child_count <= 1

    def walk_children(child_items, depth, path):
        for position, (child_index, child) in enumerate(child_items):
            if len(records) >= MAX_NODES or depth > MAX_DEPTH:
                truncation["truncated"] = True
                if depth > MAX_DEPTH:
                    truncation["maxDepthReached"] = True
                # Marks where the walk stopped, so the agent can read that parent's subtree by index.
                lines.append(("\t" * depth) + f"... {len(child_items) - position} more not shown (snapshot limit)")
                return
            walk(child, depth, path + [child_index])

    def walk(node, depth, path):
        nonlocal next_index
        item = record(node, next_index, path)
        role_key = (item["controlType"] or "").lower()
        title = item["name"] or item["automationId"] or ""
        suppressed = suppress_children(role_key, title, item["value"], None)
        child_items = [] if suppressed else list(children(node))
        generic_summary = None
        if role_key in {"panel", "filler", "unknown", "section"} and not item["name"] and not item["value"]:
            summary_values = text_snippets(node, limit=8, max_depth=4)
            if len(summary_values) >= 2 and is_plain_text_subtree(node):
                generic_summary = " ".join(summary_values)
        if should_elide(item, len(child_items), generic_summary):
            walk_children(child_items, depth, path)
            return
        records.append(item)
        next_index += 1
        if geometry_nodes is not None:
            geometry_nodes[id(item)] = node
        role_label = item["localizedControlType"] or item["controlType"]
        traits = " (disabled)" if item["isDisabled"] else ""
        line = f'{item["index"]} {role_label}{traits} {sanitize_text(title)}'.rstrip()
        line += formatted_value(role_key, title, item["value"])
        if generic_summary and generic_summary != title:
            line += ", Text: " + sanitize_text(generic_summary)
        elif role_key in {"row", "table row", "list item"}:
            row_summary = " ".join(text_snippets(node))
            if row_summary and row_summary != title:
                line += ", Text: " + sanitize_text(row_summary)
        filtered_actions = meaningful_actions(item["actions"])
        if filtered_actions:
            line += ", Secondary Actions: " + ", ".join(display_action(action) for action in filtered_actions)
        lines.append(("\t" * depth) + line)
        if generic_summary or suppressed:
            return
        child_line_start = len(lines)
        walk_children(child_items, depth + 1, path)
        if compact_browser_tabs:
            compact_rendered_browser_tabs(records, lines, child_line_start, depth + 1)

    walk(root, 0, root_path)
    return records, lines, truncation


def compact_rendered_browser_tabs(records, lines, start_line, depth):
    tab_line_indexes = [
        line_index
        for line_index in range(start_line, len(lines))
        if is_direct_rendered_browser_tab_line(lines[line_index], depth)
    ]
    if len(tab_line_indexes) < 10:
        return
    records_by_index = {int(item["index"]): item for item in records}
    active_line_indexes = {
        line_index
        for line_index in tab_line_indexes
        if is_active_rendered_browser_tab_line(lines[line_index], depth, records_by_index)
    }
    if not active_line_indexes:
        return

    omitted_record_indexes = set()
    omitted_count = 0
    insertion_index = tab_line_indexes[0]
    for line_index in reversed(tab_line_indexes):
        if line_index in active_line_indexes:
            continue
        record_index = rendered_element_index(lines[line_index], depth)
        if record_index is not None:
            omitted_record_indexes.add(record_index)
        del lines[line_index]
        omitted_count += 1
    if omitted_count <= 0:
        return
    records[:] = [item for item in records if int(item["index"]) not in omitted_record_indexes]
    lines.insert(insertion_index, ("\t" * depth) + f"... {omitted_count} inactive browser tabs omitted")


def is_direct_rendered_browser_tab_line(line, depth):
    indent = "\t" * depth
    if not line.startswith(indent):
        return False
    text = line[len(indent):]
    if text.startswith("\t"):
        return False
    return re.match(r"^\d+ (page tab|tab item|tab)($|[ (,])", text, re.IGNORECASE) is not None


def is_active_rendered_browser_tab_line(line, depth, records_by_index):
    if "(selected" in line:
        return True
    record_index = rendered_element_index(line, depth)
    record = records_by_index.get(record_index)
    if not record:
        return False
    return bool(record.get("isSelected")) or sanitize_text(record.get("value")) == "1"


def is_browser_app(query, app):
    text = f"{query} {name_of(app)}".lower()
    tokens = set(re.split(r"[^a-z0-9]+", text))
    browser_tokens = {
        "arc",
        "brave",
        "chrome",
        "chromium",
        "edge",
        "msedge",
        "firefox",
        "librewolf",
        "opera",
        "vivaldi",
        "zen",
    }
    return not tokens.isdisjoint(browser_tokens)


def rendered_element_index(line, depth):
    text = line[len("\t" * depth):]
    match = re.match(r"^(\d+)", text)
    return int(match.group(1)) if match else None


KWIN_SERVICE = "org.kde.KWin"
PORTAL_SERVICE = "org.freedesktop.portal.Desktop"
DBUS_DAEMON = ("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus")
PERMISSION_STORE = ("org.freedesktop.impl.portal.PermissionStore", "/org/freedesktop/impl/portal/PermissionStore",
                    "org.freedesktop.impl.portal.PermissionStore")
KWIN_REPORT_XML = ("<node><interface name='dev.orca.ComputerUse.KWinReport'>"
                   "<method name='Report'><arg type='s' direction='in'/></method></interface></node>")
KWIN_QUERY_SECONDS = 2
PORTAL_ANSWER_SECONDS = 10
MAX_WAYLAND_PNG_BYTES = 64_000_000
UNSUPPORTED_WAYLAND_SCREENSHOT = ("Wayland screenshots are supported on KDE Plasma, Hyprland and Sway; this desktop "
                                  "does not tell apps where windows are. Use --no-screenshot or an X11 session")
# One-shot KWin script: KWin is the only process on KDE Wayland that knows where windows are and what covers them.
KWIN_LAYOUT_SCRIPT = """(function (target) {
    function rect(value) {
        return value ? [value.x, value.y, value.width, value.height] : null;
    }
    function onCurrentDesktop(window) {
        if (window.onAllDesktops) {
            return true;
        }
        var current = workspace.currentDesktopForScreen && window.output
            ? workspace.currentDesktopForScreen(window.output) : workspace.currentDesktop;
        if (typeof current === "number") {
            return window.desktop === current;
        }
        var desktops = window.desktops || [];
        for (var i = 0; i < desktops.length; i++) {
            if (desktops[i].id === current.id) {
                return true;
            }
        }
        return false;
    }
    function onCurrentActivity(window) {
        var activities = window.activities || [];
        return activities.length === 0 || activities.indexOf(workspace.currentActivity) >= 0;
    }
    var report;
    try {
        var windows = workspace.windowList ? workspace.windowList() : workspace.clientList();
        report = {workspace: rect(workspace.virtualScreenGeometry), windows: []};
        for (var i = 0; i < windows.length; i++) {
            var window = windows[i];
            report.windows.push({
                pid: window.pid,
                caption: window.caption,
                captionNormal: window.captionNormal === undefined ? null : window.captionNormal,
                stackingOrder: window.stackingOrder,
                shown: !window.minimized && !window.hidden && !window.deleted && !window.shade
                    && onCurrentDesktop(window) && onCurrentActivity(window),
                ownedPopup: window.popupWindow === true || window.transient === true,
                client: window.clientGeometry === undefined ? null : rect(window.clientGeometry),
                buffer: rect(window.bufferGeometry),
                frame: rect(window.frameGeometry),
                screen: rect(workspace.clientArea(KWin.FullScreenArea, window))
            });
        }
    } catch (error) {
        report = {error: String(error)};
    }
    callDBus(target[0], target[1], target[2], "Report", JSON.stringify(report));
})(__ORCA_REPORT_TARGET__);
"""


def wayland_compositor():
    if os.environ.get("HYPRLAND_INSTANCE_SIGNATURE") and shutil.which("hyprctl"):
        return "hyprland"
    if os.environ.get("SWAYSOCK") and shutil.which("swaymsg"):
        return "sway"
    return None


def wayland_session():
    # Why: Sway launched from a TTY leaves XDG_SESSION_TYPE=tty, where GDK root readback has nothing to read.
    return os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland" or wayland_compositor() is not None


def session_bus():
    return Gio.bus_get_sync(Gio.BusType.SESSION, None) if Gio is not None else None


def bus_call(bus, service, path, interface, method, parameters=None, reply_type=None, timeout_ms=2000):
    return bus.call_sync(service, path, interface, method, parameters,
                         GLib.VariantType.new(reply_type) if reply_type else None,
                         Gio.DBusCallFlags.NONE, timeout_ms, None)


def bus_name_owner(bus, name):
    return attempt(lambda: bus_call(bus, *DBUS_DAEMON, "GetNameOwner", GLib.Variant("(s)", (name,)), "(s)").unpack()[0])


def wayland_screenshot_backend():
    compositor = wayland_compositor()
    if compositor is not None:
        return compositor
    bus = attempt(session_bus)
    return "kwin" if bus is not None and bus_name_owner(bus, KWIN_SERVICE) else None


def wayland_screenshot_ready():
    backend = wayland_screenshot_backend()
    if backend != "kwin":
        return backend is not None and bool(shutil.which("grim"))
    bus = session_bus()
    activatable = attempt(lambda: bus_call(bus, *DBUS_DAEMON, "ListActivatableNames", None, "(as)").unpack()[0], [])
    return bus_name_owner(bus, PORTAL_SERVICE) is not None or PORTAL_SERVICE in activatable


def screenshot_failure(message):
    return {"error": {"code": "screenshot_failed", "message": message}}


def compositor_json(command):
    with tempfile.TemporaryFile() as output:
        result = subprocess.run(command, stdout=output, stderr=subprocess.DEVNULL, timeout=2, check=False)
        if result.returncode != 0 or output.tell() > 4_000_000:
            raise ValueError("compositor query failed")
        output.seek(0)
        return json.load(output)


def hyprland_windows(pid, title):
    clients = compositor_json([shutil.which("hyprctl"), "-j", "clients"])
    matches = [item for item in clients if item.get("pid") == pid and item.get("title") == title]
    if len(matches) != 1:
        return matches, False
    monitors = compositor_json([shutil.which("hyprctl"), "-j", "monitors"])
    shown = {monitor.get(key, {}).get("id") for monitor in monitors
             for key in ("activeWorkspace", "specialWorkspace")}
    item = matches[0]
    visible = (item.get("mapped") and not item.get("hidden")
               and (item.get("pinned") or item.get("workspace", {}).get("id") in shown))
    return [item.get("at", []) + item.get("size", [])], bool(visible)


def sway_windows(pid, title):
    pending = [compositor_json([shutil.which("swaymsg"), "-t", "get_tree", "-r"])]
    matches = []
    while pending:
        item = pending.pop()
        pending.extend(item.get("nodes", []) + item.get("floating_nodes", []))
        if item.get("pid") == pid and item.get("name") == title:
            matches.append(item)
    if len(matches) != 1:
        return matches, False
    rect = matches[0].get("rect", {})
    content = matches[0].get("window_rect")
    if content:
        # Why: window_rect excludes borders and title bars drawn by Sway.
        rect = {"x": rect["x"] + content["x"], "y": rect["y"] + content["y"],
                "width": content["width"], "height": content["height"]}
    return [[rect.get(key) for key in ("x", "y", "width", "height")]], matches[0].get("visible") is True


def finite_rect(values):
    if (not isinstance(values, list) or len(values) != 4
            or any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
                   for value in values)
            or values[2] <= 0 or values[3] <= 0):
        return None
    return Rect(*(float(value) for value in values))


def wayland_window_rect(compositor, app, window):
    try:
        lookup = hyprland_windows if compositor == "hyprland" else sway_windows
        rects, visible = lookup(pid_of(app), name_of(window))
    except (OSError, subprocess.TimeoutExpired, ValueError, TypeError, AttributeError, KeyError):
        return None, "could not read window geometry from the compositor"
    if len(rects) != 1:
        return None, "no single compositor window matches this app and window title"
    # Why: grim captures a screen region, so a window off-workspace or behind a group tab would return other content.
    if not visible:
        return None, "the window is not visible on any output; switch to its workspace"
    rect = finite_rect(rects[0])
    if rect is None:
        return None, "the compositor reported invalid window geometry"
    return rect, None


def same_size(rect, bounds):
    return bounds is not None and abs(bounds.width - rect.width) <= 2 and abs(bounds.height - rect.height) <= 2


def pixel_box(rect):
    x, y = math.floor(rect.x), math.floor(rect.y)
    return x, y, math.ceil(rect.x + rect.width) - x, math.ceil(rect.y + rect.height) - y


def within_capture_limit(width, height):
    return width <= 16384 and height <= 16384 and width * height <= 67_108_864


def capture_wayland_png(bounds, app, window):
    backend = wayland_screenshot_backend()
    if backend is None:
        return screenshot_failure(UNSUPPORTED_WAYLAND_SCREENSHOT)
    if app is None or window is None:
        return screenshot_failure("Wayland screenshots need a target window")
    if backend == "kwin":
        return capture_kwin_png(bounds, app, window)
    grim = shutil.which("grim")
    if grim is None or GdkPixbuf is None:
        return screenshot_failure("Wayland screenshots require grim and GdkPixbuf; install them or use --no-screenshot")
    # AT-SPI often reports (0, 0) on Wayland, which would capture an unrelated desktop region.
    rect, error = wayland_window_rect(backend, app, window)
    if rect is None:
        return screenshot_failure(f"Wayland screenshot skipped: {error}")
    # Why: element frames are AT-SPI coordinates; a crop of another size (e.g. CSD shadows) would misplace them.
    if not same_size(rect, bounds):
        return screenshot_failure("Wayland screenshot skipped: the compositor window size differs from the accessibility bounds")
    x, y, width, height = pixel_box(rect)
    if not within_capture_limit(width, height):
        return screenshot_failure("Wayland window exceeds the screenshot dimension limit")
    try:
        with tempfile.TemporaryFile() as output:
            # Scale 1 keeps screenshot pixels aligned with window-local logical coordinates.
            result = subprocess.run([grim, "-s", "1", "-g", f"{x},{y} {width}x{height}", "-t", "png", "-"],
                                    stdout=output, stderr=subprocess.DEVNULL, timeout=5, check=False)
            size = output.tell()
            if result.returncode != 0 or not 0 < size <= MAX_WAYLAND_PNG_BYTES:
                return screenshot_failure("grim could not capture the window; check compositor screencopy support and screen-capture access")
            output.seek(0)
            pixbuf = decode_png(output.read())
            if pixbuf is None or pixbuf.get_width() != width or pixbuf.get_height() != height:
                return screenshot_failure("grim returned an image with unexpected window dimensions")
            return bounded_png_payload(pixbuf)
    except Exception as error:
        return screenshot_failure("Wayland screenshot failed: " + str(error)[:200])


def decode_png(data):
    loader = GdkPixbuf.PixbufLoader.new_with_type("png")
    loader.write(data)
    loader.close()
    return loader.get_pixbuf()


def pump_until(done, seconds):
    deadline = time.monotonic() + seconds
    context = GLib.MainContext.default()
    # Why: a periodic wake-up lets the deadline end a blocking iteration when no D-Bus message arrives.
    tick = GLib.timeout_add(20, lambda: True)
    try:
        while not done() and time.monotonic() < deadline:
            context.iteration(True)
    finally:
        GLib.source_remove(tick)
    return done()


def run_kwin_script(bus, script_id):
    try:
        bus_call(bus, KWIN_SERVICE, f"/Scripting/Script{script_id}", "org.kde.kwin.Script", "run")
    except GLib.Error:
        # Why: Plasma 5 exports loaded scripts at /<id> instead of /Scripting/Script<id>.
        bus_call(bus, KWIN_SERVICE, f"/{script_id}", "org.kde.kwin.Script", "run")


def kwin_layout(bus):
    kwin = bus_name_owner(bus, KWIN_SERVICE)
    if kwin is None:
        raise ValueError("KWin is not on the session bus")
    token = uuid.uuid4().hex
    path = "/dev/orca/ComputerUse/KWinReport/" + token
    reports = []

    def on_call(_connection, sender, _path, _interface, method, parameters, invocation):
        if sender == kwin and method == "Report":
            reports.append(parameters.unpack()[0])
        invocation.return_value(None)

    interface = Gio.DBusNodeInfo.new_for_xml(KWIN_REPORT_XML).interfaces[0]
    registration = bus.register_object(path, interface, on_call, None, None)
    plugin = "orca-computer-use-" + token
    descriptor, script_path = tempfile.mkstemp(prefix="orca-kwin-", suffix=".js", dir=os.environ.get("XDG_RUNTIME_DIR"))
    try:
        target = json.dumps([bus.get_unique_name(), path, "dev.orca.ComputerUse.KWinReport"])
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(KWIN_LAYOUT_SCRIPT.replace("__ORCA_REPORT_TARGET__", target))
        script_id = bus_call(bus, KWIN_SERVICE, "/Scripting", "org.kde.kwin.Scripting", "loadScript",
                             GLib.Variant("(ss)", (script_path, plugin)), "(i)").unpack()[0]
        if script_id < 0:
            raise ValueError("KWin refused the window layout script")
        run_kwin_script(bus, script_id)
        if not pump_until(lambda: reports, KWIN_QUERY_SECONDS):
            raise ValueError("KWin did not report window geometry")
    finally:
        attempt(lambda: bus_call(bus, KWIN_SERVICE, "/Scripting", "org.kde.kwin.Scripting", "unloadScript",
                                 GLib.Variant("(s)", (plugin,)), "(b)"))
        bus.unregister_object(registration)
        attempt(lambda: os.unlink(script_path))
    report = json.loads(reports[0])
    if not isinstance(report, dict) or report.get("error"):
        raise ValueError("KWin could not list windows: " + str(report.get("error") if isinstance(report, dict) else report)[:120])
    # Why: Plasma 6 hides windows for Show Desktop without exposing that to scripts.
    report["showingDesktop"] = attempt(lambda: bus_call(bus, KWIN_SERVICE, "/KWin", "org.freedesktop.DBus.Properties", "Get",
                                                        GLib.Variant("(ss)", (KWIN_SERVICE, "showingDesktop")), "(v)").unpack()[0])
    return report


def overlaps(a, b):
    return a.x < b.x + b.width and b.x < a.x + a.width and a.y < b.y + b.height and b.y < a.y + a.height


def kwin_window_rect(report, pid, title, bounds):
    windows = [item for item in report.get("windows") or [] if isinstance(item, dict)]
    workspace = finite_rect(report.get("workspace"))
    matches = [item for item in windows if item.get("pid") == pid and title in (item.get("captionNormal"), item.get("caption"))]
    if len(matches) != 1:
        return None, "no single KWin window matches this app and window title"
    target = matches[0]
    if target.get("shown") is not True or report.get("showingDesktop") is True:
        return None, "the window is minimized, hidden, or on another virtual desktop or activity"
    # Why: Wayland AT-SPI frames are window-local; the KWin rectangle with the toolkit's size is their origin.
    rect = next((rect for rect in (finite_rect(target.get(key)) for key in ("client", "buffer", "frame"))
                 if rect is not None and same_size(rect, bounds)), None)
    if rect is None:
        return None, "the KWin window size differs from the accessibility bounds"
    # Why: the workspace box also spans gaps between unevenly placed monitors that no screen shows.
    screen = finite_rect(target.get("screen"))
    if workspace is None or screen is None or not overlaps(screen, rect):
        return None, "the window is not on any screen"
    order = target.get("stackingOrder")
    if isinstance(order, bool) or not isinstance(order, (int, float)):
        return None, "KWin reported no stacking order for the window"
    for other in windows:
        if other is target or other.get("shown") is not True:
            continue
        # The app's own menus and dialogs are part of what it shows.
        if other.get("pid") == pid and other.get("ownedPopup") is True:
            continue
        above = other.get("stackingOrder")
        frame = finite_rect(other.get("frame"))
        if (isinstance(above, bool) or not isinstance(above, (int, float)) or above > order) and frame and overlaps(frame, rect):
            return None, "another window covers part of it"
    return (rect, workspace), None


def screenshot_permissions(bus):
    return attempt(lambda: bus_call(bus, *PERMISSION_STORE, "Lookup", GLib.Variant("(ss)", ("screenshot", "screenshot")),
                                    "(a{sas}v)").unpack()[0])


def take_portal_file(uri, not_before):
    parsed = urllib.parse.urlsplit(uri) if isinstance(uri, str) else None
    if parsed is None or parsed.scheme != "file" or parsed.netloc not in ("", "localhost"):
        raise ValueError("the desktop portal returned no local screenshot file")
    path = urllib.parse.unquote(parsed.path)
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    with os.fdopen(descriptor, "rb") as handle:
        info = os.fstat(descriptor)
        # Why: the portal saves into the user's folders; only a file it just wrote for this call is ours to read and delete.
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mtime < not_before - 1:
            raise ValueError("the desktop portal's screenshot file is not a new file of this user")
        try:
            if not 0 < info.st_size <= MAX_WAYLAND_PNG_BYTES:
                raise ValueError("the desktop portal's screenshot exceeds the size limit")
            return handle.read(MAX_WAYLAND_PNG_BYTES + 1)
        finally:
            current = attempt(lambda: os.stat(path, follow_symlinks=False))
            if current is not None and (current.st_dev, current.st_ino) == (info.st_dev, info.st_ino):
                attempt(lambda: os.unlink(path))


def portal_screenshot_png(bus):
    permissions = screenshot_permissions(bus)
    token = "orca_" + uuid.uuid4().hex
    answers = []
    subscription = bus.signal_subscribe(None, "org.freedesktop.portal.Request", "Response", None, None,
                                        Gio.DBusSignalFlags.NONE,
                                        lambda _c, sender, path, _i, _s, parameters: answers.append((sender, path, parameters.unpack())))
    started = time.time()
    try:
        options = {"handle_token": GLib.Variant("s", token), "interactive": GLib.Variant("b", False)}
        try:
            handle = bus_call(bus, PORTAL_SERVICE, "/org/freedesktop/portal/desktop", "org.freedesktop.portal.Screenshot",
                              "Screenshot", GLib.Variant("(sa{sv})", ("", options)), "(o)", 5000).unpack()[0]
        except GLib.Error as error:
            if Gio.DBusError.get_remote_error(error) in ("org.freedesktop.DBus.Error.ServiceUnknown",
                                                         "org.freedesktop.DBus.Error.UnknownInterface",
                                                         "org.freedesktop.DBus.Error.UnknownMethod"):
                raise ValueError("KDE Wayland screenshots need xdg-desktop-portal and xdg-desktop-portal-kde; install them or use --no-screenshot")
            raise
        portal = bus_name_owner(bus, PORTAL_SERVICE)
        mine = lambda: next((answer for sender, path, answer in answers if path == handle and sender == portal), None)
        if not pump_until(mine, PORTAL_ANSWER_SECONDS):
            attempt(lambda: bus_call(bus, PORTAL_SERVICE, handle, "org.freedesktop.portal.Request", "Close"))
            raise ValueError("the desktop portal did not answer; if the desktop is asking whether apps may take "
                             "screenshots, wait for the person to answer that prompt before retrying (allowing it may "
                             "leave one screenshot in their Pictures folder)")
        response, results = mine()
    finally:
        bus.signal_unsubscribe(subscription)
    if response != 0:
        raise ValueError("the desktop declined the screenshot; if a screenshot prompt was denied, allow screenshots "
                         "for this app again in the desktop's permission settings, then retry")
    data = take_portal_file(results.get("uri"), started)
    # Why: the first call shows a consent prompt that can still be fading out in this image.
    if screenshot_permissions(bus) != permissions:
        raise ValueError("screenshots were just allowed for this app; retry to capture the window")
    return data


def crop_workspace_png(data, rect, workspace):
    image = decode_png(data)
    if image is None:
        raise ValueError("the desktop portal's screenshot is not a readable PNG")
    # Why: KWin renders the whole workspace at its largest output scale; any other size means an unknown layout.
    factor = image.get_width() / workspace.width
    if abs(workspace.height * factor - image.get_height()) > 1:
        raise ValueError("the desktop portal's screenshot does not match KWin's screen layout")
    x, y, width, height = pixel_box(rect)
    left, top = round((x - workspace.x) * factor), round((y - workspace.y) * factor)
    right, bottom = round((x + width - workspace.x) * factor), round((y + height - workspace.y) * factor)
    shown_left, shown_top = max(left, 0), max(top, 0)
    shown_right, shown_bottom = min(right, image.get_width()), min(bottom, image.get_height())
    if shown_right <= shown_left or shown_bottom <= shown_top:
        raise ValueError("the window lies outside the desktop portal's screenshot")
    if not within_capture_limit(width, height) or not within_capture_limit(right - left, bottom - top):
        raise ValueError("the window exceeds the screenshot dimension limit")
    if (shown_left, shown_top, shown_right, shown_bottom) == (left, top, right, bottom):
        window = image.new_subpixbuf(left, top, right - left, bottom - top)
    else:
        # Why: a window partly off screen keeps its full size, transparent where no screen shows it, so frames stay aligned.
        window = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, True, 8, right - left, bottom - top)
        window.fill(0)
        image.copy_area(shown_left, shown_top, shown_right - shown_left, shown_bottom - shown_top,
                        window, shown_left - left, shown_top - top)
    # Logical size keeps screenshot pixels aligned with window-local accessibility frames.
    if (right - left, bottom - top) != (width, height):
        window = window.scale_simple(width, height, GdkPixbuf.InterpType.BILINEAR)
    return window


def capture_kwin_png(bounds, app, window):
    if GdkPixbuf is None:
        return screenshot_failure("KDE Wayland screenshots require GdkPixbuf; install it or use --no-screenshot")
    pid, title = pid_of(app), name_of(window)
    try:
        bus = session_bus()
        layout, error = kwin_window_rect(kwin_layout(bus), pid, title, bounds)
        if layout is None:
            return screenshot_failure(f"Wayland screenshot skipped: {error}")
        data = portal_screenshot_png(bus)
        # Why: the portal may wait on a consent prompt; a window that moved meanwhile would misalign the crop.
        after, _ = kwin_window_rect(kwin_layout(bus), pid, title, bounds)
        if after != layout:
            return screenshot_failure("Wayland screenshot skipped: the window moved, resized or was covered while capturing; retry")
        return bounded_png_payload(crop_workspace_png(data, *layout))
    except ValueError as error:
        return screenshot_failure("Wayland screenshot skipped: " + str(error)[:300])
    except Exception as error:
        return screenshot_failure("Wayland screenshot failed: " + str(error)[:200])


def capture_png(rect, app=None, window=None):
    if wayland_session():
        return capture_wayland_png(rect, app, window)
    if Gdk is None or GdkPixbuf is None or rect is None:
        return None
    screen = Gdk.Screen.get_default()
    root = screen.get_root_window() if screen else None
    if root is None:
        return None
    pixbuf = Gdk.pixbuf_get_from_window(root, round(rect.x), round(rect.y), max(1, round(rect.width)), max(1, round(rect.height)))
    if pixbuf is None:
        return None
    return bounded_png_payload(pixbuf)


def png_bytes(pixbuf):
    ok, data = pixbuf.save_to_bufferv("png", [], [])
    return bytes(data) if ok else None


def screenshot_payload(data, width, height, original_width):
    return {
        "base64": base64.b64encode(data).decode("ascii"),
        "width": width,
        "height": height,
        "scale": width / max(1, original_width),
    }


def bounded_png_payload(pixbuf):
    original_width = max(1, pixbuf.get_width())
    original_height = max(1, pixbuf.get_height())
    data = png_bytes(pixbuf)
    if data is None:
        return None
    if len(data) <= MAX_SCREENSHOT_PNG_BYTES:
        return screenshot_payload(data, original_width, original_height, original_width)

    # Why: screenshots are sent through JSON/stdout; matching macOS bounds keeps
    # large or high-DPI windows from multiplying native, base64, and Node memory.
    scale = min(1.0, MAX_SCREENSHOT_EDGE / max(original_width, original_height))
    while scale >= MIN_SCREENSHOT_SCALE:
        width = max(1, round(original_width * scale))
        height = max(1, round(original_height * scale))
        if width == original_width and height == original_height:
            scale *= SCREENSHOT_SCALE_STEP
            continue
        scaled = pixbuf.scale_simple(width, height, GdkPixbuf.InterpType.BILINEAR)
        if scaled is None:
            scale *= SCREENSHOT_SCALE_STEP
            continue
        candidate = png_bytes(scaled)
        if candidate is not None:
            if len(candidate) <= MAX_SCREENSHOT_PNG_BYTES:
                return screenshot_payload(candidate, width, height, original_width)
        scale *= SCREENSHOT_SCALE_STEP

    return {
        "error": {
            "code": "screenshot_failed",
            "message": "screenshot exceeded the computer-use payload cap after downscaling; retry with --no-screenshot or target a smaller window",
        }
    }


def first_descendant(root, predicate, max_nodes=MAX_NODES, max_depth=MAX_DEPTH):
    visited_count = 0
    stack = [(root, 0)]
    seen = {}
    while stack and visited_count < max_nodes:
        node, depth = stack.pop()
        identity = id(node)
        if identity in seen:
            continue
        seen[identity] = node
        visited_count += 1
        if predicate(node):
            return node
        if depth >= max_depth:
            continue
        # Why: focused/selection summaries run after the rendered tree is capped;
        # keep them from walking a larger or cyclic AT-SPI tree and timing out.
        child_items = list(children(node))
        for _, child in reversed(child_items):
            stack.append((child, depth + 1))
    return None


def focused_summary(window):
    node = first_descendant(window, lambda candidate: has_state(candidate, Atspi.StateType.FOCUSED))
    if node is None:
        return None
    return (role_of(node) + " " + name_of(node)).strip()


def selected_text(window):
    node = first_descendant(window, lambda candidate: has_state(candidate, Atspi.StateType.FOCUSED) and is_text_node(candidate))
    iface = text_iface(node) if node is not None else None
    selections = attempt(lambda: Atspi.Text.get_text_selections(iface), [])
    if not selections:
        return None
    selection = selections[0]
    return Atspi.Text.get_text(iface, selection.start_offset, selection.end_offset)


def app_json(app):
    return {"name": name_of(app), "bundleIdentifier": name_of(app), "pid": pid_of(app)}


def window_json(app, index, window):
    bounds = Placement(app, window).bounds()
    # Why the SCREEN fallback: a GTK 4 window with no known origin still has a true size, just no position.
    size = bounds or screen_rect(window)
    showing = has_state(window, Atspi.StateType.SHOWING)
    return {
        "index": index,
        "app": app_json(app),
        "id": None,
        "title": name_of(window),
        "x": round(bounds.x) if bounds else None,
        "y": round(bounds.y) if bounds else None,
        "width": max(0, round(size.width if size else 0)),
        "height": max(0, round(size.height if size else 0)),
        "isMinimized": not showing,
        "isOffscreen": not showing,
        "screenIndex": None,
        "platform": {"backend": "at-spi", "runtimeId": [index], "role": role_of(window)},
    }


def make_snapshot(query, include_screenshot, window_id=None, window_index=None, restore=False, root=None):
    app = find_app(query)
    window_index, window = choose_window(app, window_id, window_index)
    if restore:
        restore_window(app, window)
        window_index, window = choose_window(app, window_id, window_index)
    placement = Placement(app, window)
    bounds = placement.bounds()
    tree_root, root_path = window, [window_index]
    if root is not None:
        tree_root = find_element(app, root)
        if tree_root is None:
            raise RuntimeError(f"stale element: element {root.get('index')} is gone; run get-app-state again and use a fresh element index")
        root_path = list(root.get("runtimeId") or [])
    geometry_nodes = {}
    records, lines, truncation = render_accessibility_tree(
        tree_root,
        root_path,
        compact_browser_tabs=is_browser_app(query, app),
        geometry_nodes=geometry_nodes,
    )
    focused = focused_summary(window)
    selection = selected_text(window)
    app_info = app_json(app)
    window_title = name_of(window)
    screenshot = capture_png(bounds, app, window) if include_screenshot else None
    if include_screenshot and bounds is None and placement.window_coords:
        screenshot = screenshot_failure("GTK 4 screenshot skipped: Orca can't tell where this window sits on screen; "
                                        "use --no-screenshot and trust the tree")
    geometry = GeometryReader()
    for item in records:
        node = geometry_nodes[id(item)]
        rect = placement.frame(node, geometry.read)
        item["frame"] = rect.to_json() if rect else None
    return {
        "snapshotId": str(uuid.uuid4()),
        "app": app_info,
        "windowTitle": window_title,
        "windowId": None,
        "windowIndex": window_index,
        "windowBounds": bounds.to_json() if bounds else None,
        "screenshotPngBase64": screenshot.get("base64") if screenshot else None,
        "screenshotWidth": screenshot.get("width") if screenshot else None,
        "screenshotHeight": screenshot.get("height") if screenshot else None,
        "screenshotScale": screenshot.get("scale") if screenshot else None,
        "screenshotError": screenshot.get("error") if screenshot else None,
        "coordinateSpace": "window",
        "truncation": truncation,
        "treeLines": lines,
        "focusedSummary": focused,
        "selectedText": selection,
        "elements": records,
    }


def list_apps_response():
    apps = []
    for app in sorted(desktop_apps(), key=lambda value: (name_of(value).lower(), pid_of(value))):
        if windows_for(app):
            apps.append({"name": name_of(app), "bundleIdentifier": name_of(app), "pid": pid_of(app)})
    return apps


def list_windows_response(query):
    app = find_app(query)
    return {"app": app_json(app), "windows": [window_json(app, index, window) for index, window in windows_for(app)]}


def handshake_response():
    # Why: pointer-only verbs have no route on native Wayland, where synthetic input never lands.
    is_wayland = wayland_session()
    has_hotkey = shutil.which("xdotool") is not None and not is_wayland
    has_clipboard = any(shutil.which(command) for command in ("wl-copy", "xclip", "xsel"))
    has_screenshot = GdkPixbuf is not None and (
        attempt(wayland_screenshot_ready, False) if wayland_session() else Gdk is not None
    )
    return {
        "platform": "linux",
        "provider": "orca-computer-use-linux",
        "providerVersion": "1.0.0",
        "protocolVersion": 1,
        "supports": {
            "apps": {"list": True, "bundleIds": False, "pids": True},
            "windows": {"list": True, "targetById": False, "targetByIndex": True, "focus": False, "moveResize": False},
            "observation": {"screenshot": has_screenshot, "annotatedScreenshot": False, "elementFrames": True, "ocr": False, "disabledState": True},
            "actions": {
                "click": True,
                "typeText": True,
                "typeTextElement": True,
                "pressKey": True,
                "hotkey": has_hotkey,
                "pasteText": has_clipboard,
                "scroll": True,
                "drag": not is_wayland,
                "setValue": True,
                "performAction": True,
            },
            "surfaces": {"menus": False, "dialogs": False, "dock": False, "menubar": False},
        },
    }


def find_by_path(app, path):
    node = app
    for index in path or []:
        node = dict(children(node)).get(int(index))
        if node is None:
            return None
    return node


def all_nodes(root):
    result = []

    def walk(node):
        result.append(node)
        for _, child in children(node):
            # Why check before each child: every lookup is an AT-SPI round trip, and a list can hold thousands.
            if len(result) >= MAX_NODES:
                return
            walk(child)

    walk(root)
    return result


def find_element(app, saved):
    if not saved:
        return None
    by_path = find_by_path(app, saved.get("runtimeId"))
    if by_path is not None and same_element_signature(by_path, saved):
        return by_path
    return None


def same_element_signature(node, saved):
    if role_of(node) != str(saved.get("controlType") or ""):
        return False
    if name_of(node) != str(saved.get("name") or ""):
        return False
    if accessible_id(node) != str(saved.get("automationId") or ""):
        return False
    saved_actions = [str(action) for action in saved.get("actions") or []]
    return action_labels(node) == saved_actions


def preferred_action(node):
    if node is None:
        return None
    priority = {"click", "press", "activate", "invoke", "select", "toggle", "open"}
    fallback = None
    for index in range(int(attempt(node.get_n_actions, 0) or 0)):
        label = str(attempt(lambda i=index: node.get_action_name(i), "") or "").lower()
        if label in priority:
            return index
        if fallback is None and any(term in label for term in ("click", "press", "activate")):
            fallback = index
    return fallback


def perform_action(node, index):
    return bool(index is not None and attempt(lambda: node.do_action(int(index)), False))


def action_names(node):
    count = int(attempt(node.get_n_actions, 0) or 0)
    return [str(attempt(lambda i=index: node.get_action_name(i), "") or "") for index in range(count)]


def compact_action(label):
    return re.sub(r"[\s_-]", "", str(label or "").lower())


def toolkit_kind(app):
    name = text_attr(app, lambda: app.get_toolkit_name()).lower()
    if name == "gtk":
        major = re.match(r"\d+", text_attr(app, lambda: app.get_toolkit_version()))
        return None if major is None else "gtk3" if int(major.group()) < 4 else "gtk4"
    return name or None


def opens_popup_without_selection(node):
    states = attempt(node.get_state_set)
    has_popup = getattr(Atspi.StateType, "HAS_POPUP", None)
    # Why: a state set that can't be read never proves the action safe.
    popup = states is None or has_popup is None or state_set_contains(states, has_popup, True)
    return popup and attempt(lambda: node.get_selection_iface()) is None


def popup_owner(node):
    parent = attempt(lambda: node.get_parent())
    if parent is not None and role_of(parent).lower() in {"push button", "toggle button", "menu button"}:
        return parent
    ancestor = parent
    for _ in range(MAX_DEPTH):
        if ancestor is None:
            return None
        if role_of(ancestor).lower() == "combo box":
            return ancestor
        ancestor = attempt(lambda: ancestor.get_parent())
    return None


def foreground_effect(app, node, action, activates):
    """Why running action on node would take the foreground, or None (port of agent-desktop actions/foreground.rs@pr-660)."""
    if any(compact_action(label) == "showmenu" for label in action_names(node)):
        return "opens a menu over the user's window"
    if compact_action(action) in {"setfocus", "grabfocus"}:
        return "moves keyboard focus, which activates the window"
    # Why: GTK 3 popovers and dialog openers stay below the user's window (agent-desktop C3, L-W0-13).
    if toolkit_kind(app) == "gtk3":
        return None
    name = attempt(lambda: node.get_name())
    if activates and (name is None or str(name).rstrip().endswith(("…", "..."))):
        return "opens a dialog (its label ends in an ellipsis), which takes the foreground"
    if opens_popup_without_selection(node):
        return "opens a popup that takes the keyboard"
    owner = popup_owner(node)
    if owner is not None and opens_popup_without_selection(owner):
        return "opens its parent's popup, which takes the keyboard"
    return None


def refuse_foreground_effect(app, node, window, action, activates, operation):
    effect = foreground_effect(app, node, action, activates)
    if effect is not None and operation.get("restoreWindow"):
        # Why: the user allowed the takeover, so the menu or dialog opens over its own window, not behind the user's.
        restore_window(app, window)
    elif effect is not None:
        role, name = role_of(node), sanitize_text(name_of(node))
        raise RuntimeError(f'background_unavailable: the {role} "{name}" {effect}; nothing was sent. {RESTORE_HINT}')


def activate_focused_entry(app, window):
    """Press Return in a GTK text entry through its AT-SPI activate action, which is what Return does there."""
    if toolkit_kind(app) not in {"gtk3", "gtk4"}:
        return None
    node = first_descendant(window, lambda candidate: has_state(candidate, Atspi.StateType.FOCUSED))
    multi_line = getattr(Atspi.StateType, "MULTI_LINE", None)
    if node is None or not has_state(node, Atspi.StateType.EDITABLE) or (multi_line is not None and has_state(node, multi_line)):
        return None
    names = [compact_action(label) for label in action_names(node)]
    if "activate" not in names or not perform_action(node, names.index("activate")):
        return None
    return {"path": "accessibility", "actionName": "activate", "fallbackReason": None,
            "verification": {"state": "unverified", "reason": "accessibility_action_unasserted"}}


def screen_point(placed, saved_element=None, x=None, y=None, node=None):
    if placed.window_coords and placed.origin is None:
        raise RuntimeError("unsupported capability: Orca can't tell where this GTK 4 window sits on screen, so "
                           "pointer input would miss; nothing was sent. Use an element's accessibility action or set-value")
    window_rect = placed.screen(placed.window)
    rect = placed.screen(node) if node is not None else None
    if rect is not None:
        return rect.x + rect.width / 2, rect.y + rect.height / 2
    if saved_element is not None:
        raise RuntimeError("stale element frame; run get-app-state again and use a fresh element index")
    if window_rect is None or x is None or y is None:
        raise RuntimeError("coordinate action requires a visible window and coordinates")
    return window_rect.x + float(x), window_rect.y + float(y)


def window_point(placed, saved_element=None, x=None, y=None, node=None):
    point = screen_point(placed, saved_element, x, y, node)
    window_rect = placed.screen(placed.window)
    if (window_rect is None or not window_rect.x <= point[0] < window_rect.x + window_rect.width
            or not window_rect.y <= point[1] < window_rect.y + window_rect.height):
        raise RuntimeError("coordinate action target lies outside the target window, so the pointer would land on "
                           "another window; nothing was sent. Run get-app-state again and target a point inside it")
    return point


def require_positive_integer(value, name):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise RuntimeError(f"{name} must be a positive integer")
    if parsed <= 0:
        raise RuntimeError(f"{name} must be a positive integer")
    return parsed


def require_positive_number(value, name):
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        raise RuntimeError(f"{name} must be a positive number")
    if not math.isfinite(parsed) or parsed <= 0:
        raise RuntimeError(f"{name} must be a positive number")
    return parsed


def require_non_empty_string(value, name):
    if value is None or str(value) == "":
        raise RuntimeError(f"{name} is required")
    return str(value)


def click_at(x, y, button, count, modifiers=None):
    button = (button or "left").lower()
    buttons = {"left": ("b1p", "b1r"), "right": ("b3p", "b3r"), "middle": ("b2p", "b2r")}
    if button not in buttons:
        raise RuntimeError(f"unsupported mouse button: {button}")
    parsed_count = require_positive_integer(1 if count is None else count, "click_count")
    modifier_keys = click_modifier_keys(modifiers)
    if modifier_keys:
        modified_click_at(x, y, button, parsed_count, modifier_keys)
        return
    down, up = buttons[button]
    for _ in range(parsed_count):
        Atspi.generate_mouse_event(round(x), round(y), "abs")
        press_and_release(round(x), round(y), down, up)


def press_and_release(x, y, down, up):
    Atspi.generate_mouse_event(x, y, down)
    try:
        time.sleep(0.03)
    finally:
        # Why: an interrupted press must not leave the button held while the pointer is put back.
        Atspi.generate_mouse_event(x, y, up)


def click_modifier_keys(raw):
    if raw is None:
        return []
    aliases = {
        "ctrl": "ctrl", "control": "ctrl", "cmdorctrl": "ctrl", "commandorcontrol": "ctrl",
        "shift": "shift", "alt": "alt", "option": "alt",
        "meta": "super", "super": "super", "win": "super", "cmd": "super", "command": "super",
    }
    parts = [part.strip().lower() for part in str(raw).split("+")]
    if not parts or any(not part or part not in aliases for part in parts):
        raise RuntimeError("click modifiers require modifier keys only")
    return list(dict.fromkeys(aliases[part] for part in parts))


def modified_click_at(x, y, button, count, modifier_keys):
    xdotool = shutil.which("xdotool")
    is_wayland = wayland_session()
    if not xdotool or is_wayland:
        raise RuntimeError("modified clicks require xdotool on an X11 session")
    button_number = {"left": "1", "middle": "2", "right": "3"}[button]
    command = [xdotool, "mousemove", "--sync", str(round(x)), str(round(y))]
    for modifier in modifier_keys:
        command.extend(["keydown", modifier])
    command.extend(["click", "--repeat", str(count), "--delay", "35", button_number])
    for modifier in reversed(modifier_keys):
        command.extend(["keyup", modifier])
    try:
        subprocess.run(command, check=True, timeout=5)
    finally:
        subprocess.run(
            [xdotool, *[item for modifier in reversed(modifier_keys) for item in ("keyup", modifier)]],
            check=False,
            timeout=2,
        )


def scroll_at(x, y, direction, pages):
    if direction is None or str(direction).strip() == "":
        raise RuntimeError("direction is required")
    direction = str(direction).lower()
    wheel_events = {
        "up": ("b4p", "b4r"),
        "down": ("b5p", "b5r"),
        "left": ("b6p", "b6r"),
        "right": ("b7p", "b7r"),
    }
    if direction not in wheel_events:
        raise RuntimeError(f"unsupported scroll direction: {direction}")
    down, up = wheel_events[direction]
    page_count = max(1, math.ceil(require_positive_number(1 if pages is None else pages, "pages")))
    for _ in range(page_count):
        Atspi.generate_mouse_event(round(x), round(y), "abs")
        press_and_release(round(x), round(y), down, up)


def drag_between(start, end):
    Atspi.generate_mouse_event(round(start[0]), round(start[1]), "abs")
    Atspi.generate_mouse_event(round(start[0]), round(start[1]), "b1p")
    x, y = start
    try:
        for step in range(1, 13):
            x = start[0] + (end[0] - start[0]) * step / 12
            y = start[1] + (end[1] - start[1]) * step / 12
            Atspi.generate_mouse_event(round(x), round(y), "abs")
            time.sleep(0.02)
    finally:
        Atspi.generate_mouse_event(round(x), round(y), "b1r")


SCROLL_DIRECTIONS = {"up": ("vertical", -1), "down": ("vertical", 1), "left": ("horizontal", -1), "right": ("horizontal", 1)}
DOCUMENT_ROLES = {"document web", "document frame", "scroll pane"}
MAX_SCROLL_BAR_SIBLINGS = 8
MAX_SCROLL_TO_PAGES = 10
SCROLL_SETTLE_SECONDS = 1


def scroll_direction(raw):
    direction = str(raw or "").strip().lower()
    if not direction:
        raise RuntimeError("direction is required")
    if direction not in SCROLL_DIRECTIONS:
        raise RuntimeError(f"unsupported scroll direction: {direction}")
    return SCROLL_DIRECTIONS[direction]


def scroll_without_pointer(window, node, placed, x, y, direction, pages):
    """Scroll through scroll bar values or Component.ScrollTo, which move no pointer and raise no window
    (agent-desktop actions/scroll/scroll_bus.rs; FINDINGS L4-22)."""
    axis, sign = scroll_direction(direction)
    pages = require_positive_number(1 if pages is None else pages, "pages")
    if node is None and x is not None and y is not None:
        node = node_at(window, placed, float(x), float(y), [MAX_NODES])
    at_limit, budget = None, [MAX_NODES]
    # Why innermost first: like a wheel, the nearest view that can move takes the scroll, and one at its end hands it out.
    for container in ancestors_to(node, window):
        bar = scroll_bar(container, axis)
        if bar is not None:
            action = write_scroll_bar(container, bar, axis, sign, pages)
        elif float(pages).is_integer():
            action = scroll_to_pages(container, placed, axis, sign, int(pages), budget)
        else:
            continue
        if action is not None and action["verification"].get("reason") != "suspected_noop":
            return action
        at_limit = at_limit or action
    return at_limit


def ancestors_to(node, window):
    found, current = [], node
    for _ in range(MAX_DEPTH):
        if current is None:
            break
        found.append(current)
        if current is window or current == window:
            break
        current = attempt(lambda current=current: current.get_parent())
    return found


def node_at(window, placed, x, y, budget):
    """The deepest node whose window-relative frame holds the point, preferring later (topmost) siblings."""
    node = window
    for _ in range(MAX_DEPTH):
        hit = None
        count = int(attempt(lambda node=node: node.get_child_count(), 0) or 0)
        for index in range(count - 1, -1, -1):
            budget[0] -= 1
            if budget[0] < 0:
                return node
            child = attempt(lambda node=node, index=index: node.get_child_at_index(index))
            frame = placed.frame(child) if child is not None else None
            if frame is not None and frame.x <= x < frame.x + frame.width and frame.y <= y < frame.y + frame.height:
                hit = child
                break
        if hit is None:
            return node
        node = hit
    return node


def scroll_bar(container, axis):
    vertical, horizontal = (getattr(Atspi.StateType, name, None) for name in ("VERTICAL", "HORIZONTAL"))
    # Why capped: scroll bars sit beside one viewport child, and reading every row of a big list costs the app memory.
    if int(attempt(lambda: container.get_child_count(), 0) or 0) > MAX_SCROLL_BAR_SIBLINGS:
        return None
    for _, child in children(container):
        if role_of(child).lower() != "scroll bar":
            continue
        if vertical is not None and has_state(child, vertical):
            matches = axis == "vertical"
        elif horizontal is not None and has_state(child, horizontal):
            matches = axis == "horizontal"
        else:
            rect = screen_rect(child)
            matches = rect is not None and (rect.height > rect.width) == (axis == "vertical")
        value = attempt(lambda child=child: child.get_value_iface()) if matches else None
        if value is None:
            continue
        low, high, current = (attempt(lambda read=read: read(value)) for read in (
            Atspi.Value.get_minimum_value, Atspi.Value.get_maximum_value, Atspi.Value.get_current_value))
        if None not in (low, high, current) and high > low:
            return value, float(low), float(high), float(current)
    return None


def write_scroll_bar(container, bar, axis, sign, pages):
    value, low, high, current = bar
    viewport = screen_rect(container)
    if viewport is None:
        return None
    # Why the viewport length: toolkit adjustments count pixels, so one page is one viewport (scroll_plan.rs).
    page = viewport.height if axis == "vertical" else viewport.width
    wanted = min(high, max(low, current + sign * pages * page))
    action = {"path": "accessibility", "actionName": "scrollBarValue", "fallbackReason": None}
    if abs(wanted - current) < 0.5:
        action["verification"] = {"state": "unverified", "reason": "suspected_noop"}
        return action
    if not attempt(lambda: Atspi.Value.set_current_value(value, wanted), False):
        return None
    readback = attempt(lambda: Atspi.Value.get_current_value(value))
    action["verification"] = ({"state": "verified", "property": "value"}
                              if readback is not None and abs(float(readback) - wanted) < 0.5
                              else {"state": "unverified", "reason": "value_mismatch"})
    return action


def scroll_to_pages(container, placed, axis, sign, pages, budget):
    edges = {("vertical", 1): "TOP_EDGE", ("vertical", -1): "BOTTOM_EDGE",
             ("horizontal", 1): "LEFT_EDGE", ("horizontal", -1): "RIGHT_EDGE"}
    scroll_type = getattr(getattr(Atspi, "ScrollType", None), edges[(axis, sign)], None)
    if scroll_type is None:
        return None
    moved = accepted = 0
    at_end = False
    for _ in range(min(pages, MAX_SCROLL_TO_PAGES)):
        viewport = placed.frame(container)
        if viewport is None:
            break
        start, length = (viewport.y, viewport.height) if axis == "vertical" else (viewport.x, viewport.width)
        item = item_past_edge(container, placed, axis, sign, start, start + length, MAX_DEPTH, budget)
        at_end = item is None and budget[0] >= 0
        component = attempt(lambda: item.get_component_iface()) if item is not None else None
        before = placed.frame(item) if component is not None else None
        if before is None or not attempt(lambda: Atspi.Component.scroll_to(component, scroll_type), False):
            break
        accepted += 1
        if not wait_item_moved(item, placed, axis, before):
            break
        moved += 1
    if not accepted:
        # Why only documents: a document with nothing past its edge is at its end, while other nodes may not scroll.
        if at_end and role_of(container).lower() in DOCUMENT_ROLES:
            return {"path": "accessibility", "actionName": "scrollTo", "fallbackReason": None,
                    "verification": {"state": "unverified", "reason": "suspected_noop"}}
        return None
    # Why an action after any page: once the document moved, falling back to the pointer would scroll it twice.
    verification = ({"state": "unverified", "reason": "accessibility_action_unasserted"} if moved
                    else {"state": "unverified", "reason": "suspected_noop"})
    return {"path": "accessibility", "actionName": "scrollTo", "fallbackReason": None, "verification": verification}


def item_past_edge(node, placed, axis, sign, viewport_start, viewport_end, depth, budget):
    """The item that should lead the next page: the first one cut by or beyond the viewport edge we scroll toward."""
    if depth <= 0:
        return None
    edge = viewport_end if sign > 0 else viewport_start
    count = int(attempt(lambda: node.get_child_count(), 0) or 0)
    for index in (range(count) if sign > 0 else range(count - 1, -1, -1)):
        # Why a shared budget: each child is an AT-SPI round trip, and a document can hold thousands.
        budget[0] -= 1
        if budget[0] < 0:
            return None
        child = attempt(lambda index=index: node.get_child_at_index(index))
        frame = placed.frame(child) if child is not None else None
        if frame is None:
            continue
        start, end = (frame.y, frame.y + frame.height) if axis == "vertical" else (frame.x, frame.x + frame.width)
        if (start >= edge - 1) if sign > 0 else (end <= edge + 1):
            return child
        if start < edge < end:
            inner = item_past_edge(child, placed, axis, sign, viewport_start, viewport_end, depth - 1, budget)
            # Why the cut item itself: its hidden part leads the next page, unless it already fills the viewport.
            leads = start > viewport_start + 1 if sign > 0 else end < viewport_end - 1
            if inner is not None or leads:
                return inner if inner is not None else child
    return None


def wait_item_moved(item, placed, axis, before):
    """Wait until ScrollTo moved the item, so the next page is planned from settled geometry."""
    deadline = time.monotonic() + SCROLL_SETTLE_SECONDS
    was = before.y if axis == "vertical" else before.x
    while True:
        frame = placed.frame(item)
        now = None if frame is None else frame.y if axis == "vertical" else frame.x
        if now is not None and abs(now - was) > 1:
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.05)


def select_in_parent(app, node):
    """Select a row through its container's Selection, proving the index names this row first (select_index.rs)."""
    parent = attempt(lambda: node.get_parent()) if node is not None else None
    selection = attempt(lambda: parent.get_selection_iface()) if parent is not None else None
    index = attempt(lambda: node.get_index_in_parent()) if selection is not None else None
    if index is None or index < 0 or not selection_indices_proven(app, parent, selection):
        return None
    if attempt(lambda: parent.get_child_at_index(index)) != node:
        raise RuntimeError("stale element: the selection index no longer names this element; run get-app-state again and use a fresh element index")
    multiselectable = getattr(Atspi.StateType, "MULTISELECTABLE", None)
    # Why clear first: a plain click replaces the selection, while SelectChild adds to a multi-select list's.
    if (multiselectable is not None and has_state(parent, multiselectable)
            and not attempt(lambda: Atspi.Selection.clear_selection(selection), False)):
        return None
    if not attempt(lambda: Atspi.Selection.select_child(selection, index), False):
        return None
    attempt(lambda: node.clear_cache())
    verified = has_state(node, Atspi.StateType.SELECTED)
    return {"path": "accessibility", "actionName": "selectChild", "fallbackReason": None,
            "verification": {"state": "verified", "property": "selection"} if verified
            else {"state": "unverified", "reason": "accessibility_action_unasserted"}}


def selection_indices_proven(app, parent, selection):
    # Why: GTK 4 Selection counts item widgets, which can differ from its accessible children (select_index.rs).
    if toolkit_kind(app) in {"gtk3", "qt", "chromium", "gecko"}:
        return True
    count = int(attempt(lambda: parent.get_child_count(), 0) or 0)

    def answer(index):
        try:
            Atspi.Selection.is_child_selected(selection, index)
            return "answered"
        except Exception as error:
            # Why only InvalidArgs: a timeout or lost connection proves nothing about the index space.
            return "refused" if "InvalidArgs" in str(error) else "unknown"

    # Why counted: the index spaces match exactly when the last child answers and the one past it is refused.
    return count > 0 and answer(count - 1) == "answered" and answer(count) == "refused"


def is_enter_key(raw):
    return key_name(raw) in {"Return", "KP_Enter"}


def key_name(raw):
    aliases = {
        "return": "Return", "enter": "Return", "tab": "Tab", "escape": "Escape", "esc": "Escape",
        "backspace": "BackSpace", "delete": "Delete", "space": "space", "left": "Left", "right": "Right",
        "up": "Up", "down": "Down", "home": "Home", "end": "End", "insert": "Insert",
        "pageup": "Page_Up", "page_up": "Page_Up", "pagedown": "Page_Down", "page_down": "Page_Down",
    }
    return aliases.get(str(raw).lower(), str(raw))


def press_key(raw, window=None):
    name = key_name(raw)
    if len(name) == 1:
        type_text(name, window)
        return
    if Gdk is None:
        raise RuntimeError("GDK is required for non-character key synthesis")
    require_idle_keyboard()
    Atspi.generate_keyboard_event(Gdk.keyval_from_name(name), None, Atspi.KeySynthType.SYM)


def hotkey(raw, window=None):
    key_spec = re.sub(r"(?i)commandorcontrol|cmdorctrl", "ctrl", str(raw))
    if "+" in key_spec:
        # xdotool treats an upper-case letter as its shifted keysym, so ctrl+A would press ctrl+shift+a.
        key_spec = "+".join(part.lower() if len(part) == 1 else part for part in key_spec.split("+"))
    xdotool = shutil.which("xdotool")
    if xdotool:
        require_idle_keyboard()
        subprocess.run([xdotool, "key", key_spec], check=True)
        return
    if "+" in key_spec:
        raise RuntimeError("hotkey combinations require xdotool")
    press_key(key_spec, window)


@contextmanager
def temporary_x11_keymap(value, read_receipt):
    import fcntl

    if Gdk is None and not value.isascii():
        raise RuntimeError("unsupported capability: synthetic Unicode text requires GDK on X11")
    lock = open(os.path.join(os.environ["XDG_RUNTIME_DIR"], "orca-computer-keyboard.lock"), "a")
    try:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("unsupported capability: another keyboard operation is active; retry after it finishes") from error
        with locked_x11_keymap(value, read_receipt) as receipt:
            yield receipt
    finally:
        lock.close()


@contextmanager
def locked_x11_keymap(value, read_receipt):
    x = ctypes.CDLL("libX11.so.6")
    pointer, integer, symbol = ctypes.c_void_p, ctypes.c_int, ctypes.c_ulong

    class ModifierMap(ctypes.Structure):
        _fields_ = [("width", integer), ("keys", ctypes.POINTER(ctypes.c_ubyte))]

    for name, result, args in (
        ("XOpenDisplay", pointer, [ctypes.c_char_p]),
        ("XDisplayKeycodes", integer, [pointer, ctypes.POINTER(integer), ctypes.POINTER(integer)]),
        ("XGetKeyboardMapping", ctypes.POINTER(symbol), [pointer, ctypes.c_ubyte, integer, ctypes.POINTER(integer)]),
        ("XGetModifierMapping", ctypes.POINTER(ModifierMap), [pointer]),
        ("XQueryKeymap", integer, [pointer, ctypes.POINTER(ctypes.c_char)]),
        ("XChangeKeyboardMapping", integer, [pointer, integer, integer, ctypes.POINTER(symbol), integer]),
        ("XFree", integer, [pointer]),
        ("XFreeModifiermap", integer, [ctypes.POINTER(ModifierMap)]),
        ("XSync", integer, [pointer, integer]),
        ("XCloseDisplay", integer, [pointer]),
    ):
        fn = getattr(x, name)
        fn.restype, fn.argtypes = result, args
    display = x.XOpenDisplay(None)
    if not display:
        raise RuntimeError("unsupported capability: cannot open X11 display for synthetic Unicode text")
    changed = []
    held_before = None
    completed = False

    def held_keys():
        keys = (ctypes.c_char * 32)()
        x.XQueryKeymap(display, keys)
        return bytes(keys)

    def restore():
        nonlocal display
        if display is None:
            return
        previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGTERM})
        try:
            if not completed and held_before is not None:
                held_after = held_keys()
                newly_down = [code for code in range(256)
                              if held_after[code // 8] & (1 << (code % 8))
                              and not held_before[code // 8] & (1 << (code % 8))]
                if newly_down:
                    xtest = ctypes.CDLL("libXtst.so.6")
                    xtest.XTestFakeKeyEvent.argtypes = [pointer, ctypes.c_uint, integer, ctypes.c_ulong]
                    for code in newly_down:
                        xtest.XTestFakeKeyEvent(display, code, 0, 0)
            for code in changed:
                x.XChangeKeyboardMapping(display, code, width.value, (symbol * width.value)(*rows[code]), 1)
            x.XSync(display, 0)
            x.XCloseDisplay(display)
            display = None
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)

    try:
        low, high, width = integer(), integer(), integer()
        x.XDisplayKeycodes(display, ctypes.byref(low), ctypes.byref(high))
        raw = x.XGetKeyboardMapping(display, low.value, high.value - low.value + 1, ctypes.byref(width))
        if not raw:
            raise RuntimeError("unsupported capability: cannot read X11 keyboard mapping")
        try:
            rows = {code: tuple(raw[(code - low.value) * width.value + i] for i in range(width.value))
                    for code in range(low.value, high.value + 1)}
        finally:
            x.XFree(raw)
        modifiers = x.XGetModifierMapping(display)
        if not modifiers:
            raise RuntimeError("unsupported capability: cannot read X11 modifier mapping")
        try:
            modifier_codes = set(modifiers.contents.keys[i] for i in range(modifiers.contents.width * 8))
        finally:
            x.XFreeModifiermap(modifiers)
        available = {key for row in rows.values() for key in row}
        needed = list(dict.fromkeys((ord(char) if ord(char) < 128 else Gdk.unicode_to_keyval(ord(char)))
                                    for char in value if is_literal_text_character(char)))
        missing = [key for key in needed if key not in available]
        free = [code for code, row in rows.items() if not any(row) and code not in modifier_codes]
        if len(missing) > len(free) or 0 in missing:
            raise RuntimeError("unsupported capability: insufficient unused X11 keycodes; split the text or use paste_text")
        receipt = read_receipt() if missing else None
        if missing and receipt is None:
            raise RuntimeError("unsupported capability: synthetic Unicode mapping requires readable focused text; use paste_text")
        for code, key in zip(free, missing):
            changed.append(code)
            binding = (symbol * width.value)(key)
            x.XChangeKeyboardMapping(display, code, width.value, binding, 1)
        x.XSync(display, 0)
        held_before = held_keys()
        yield receipt
        completed = True
    finally:
        try:
            restore()
        except SystemExit:
            restore()
            raise


def is_literal_text_character(char):
    return ord(char) >= 32 and ord(char) != 127


def synthetic_text_receipt(window, value):
    if not all(is_literal_text_character(char) for char in value):
        return None
    node = first_descendant(window, lambda candidate: has_state(candidate, Atspi.StateType.FOCUSED)) if window is not None else None
    if node is None or is_secure_node(node) or not has_state(node, Atspi.StateType.EDITABLE):
        return None
    text = text_iface(node)
    selection = text_selection(text) if text is not None else None
    if selection is None:
        return None
    start, end, count = selection
    original = attempt(lambda: Atspi.Text.get_text(text, 0, count))
    if original is None or len(original) != count or "\ufffc" in original:
        return None
    if start != end:
        get_selections = getattr(getattr(Atspi, "Document", None), "get_text_selections", None)
        selections = None
        ancestor = node
        if get_selections is not None:
            for _ in range(MAX_DEPTH):
                document = attempt(lambda: ancestor.get_document_iface())
                if document is not None:
                    selections = attempt(lambda: get_selections(document))
                    break
                ancestor = attempt(lambda: ancestor.get_parent())
                if ancestor is None:
                    break
        if selections:
            if len(selections) != 1:
                return None
            selected = selections[0]
            if selected.start_object != node or selected.end_object != node:
                return None
            caret = attempt(lambda: Atspi.Text.get_caret_offset(text))
            if caret != (selected.start_offset if selected.start_is_active else selected.end_offset):
                return None
            start, end = sorted((selected.start_offset, selected.end_offset))
            if not 0 <= start < end <= count:
                return None
        elif any(ord(char) > 0xFFFF for char in original):
            # Legacy ATK selection offsets can convert supplementary characters twice.
            return None
    return node, text, original[:start] + value + original[end:], start + len(value)


def wait_for_typed_text(receipt):
    node, text, expected, caret = receipt
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        attempt(node.clear_cache)
        if (has_state(node, Atspi.StateType.FOCUSED)
                and attempt(lambda: Atspi.Text.get_text(text, 0, -1)) == expected
                and attempt(lambda: Atspi.Text.get_caret_offset(text)) == caret
                and attempt(lambda: Atspi.Text.get_n_selections(text)) == 0):
            return
        time.sleep(0.02)
    raise RuntimeError("text_input_incomplete: typed text or caret did not match; inspect state before retrying")


TYPE_CHUNK_CHARACTERS = 40


def type_text(value, window=None):
    text = str(value)
    xdotool = shutil.which("xdotool")
    if not xdotool and text.isascii():
        require_idle_keyboard()
        Atspi.generate_keyboard_event(0, text, Atspi.KeySynthType.STRING)
        return
    if not xdotool:
        raise RuntimeError("unsupported capability: synthetic Unicode text requires xdotool on X11")
    # Keep normal typing below both the child and provider watchdogs.
    if len(text) > 600:
        raise RuntimeError("unsupported capability: synthetic text is limited to 600 characters; split the text or use paste_text")
    Atspi.set_timeout(ATSPI_METHOD_TIMEOUT_MS, ATSPI_STARTUP_TIMEOUT_MS)
    stopped = None
    with temporary_x11_keymap(text, lambda: synthetic_text_receipt(window, text)) as receipt:
        typed = 0
        for start in range(0, len(text), TYPE_CHUNK_CHARACTERS):
            chunk = text[start:start + TYPE_CHUNK_CHARACTERS]
            # Why per chunk: the user can switch windows or hold a key while a long text is typed.
            if window is not None and not has_state(window, Atspi.StateType.ACTIVE):
                stopped = RuntimeError(f"text_input_incomplete: the target window lost focus after {typed} of {len(text)} characters; the rest was not typed; inspect state before retrying")
                break
            try:
                mask = require_idle_keyboard()
            except RuntimeError as error:
                # Why break, not raise: an exception exit releases newly held keys, which here are the user's.
                stopped = error if typed == 0 else RuntimeError(f"text_input_incomplete: a modifier key was pressed after {typed} of {len(text)} characters; the rest was not typed; inspect state before retrying")
                break
            # Why: --clearmodifiers would release keys the user holds; with none held it only lifts Caps Lock.
            clear = ["--clearmodifiers"] if mask is not None and mask & LOCK_MASK else []
            try:
                # A fresh xdotool reads the stable mappings, held until the target consumes its keys.
                subprocess.run(
                    [xdotool, "type", *clear, "--delay", "12", "--file", "-"],
                    input=chunk, encoding="utf-8", env={**os.environ, "LC_ALL": "C.UTF-8"},
                    check=True, capture_output=True, timeout=10,
                )
            except (subprocess.SubprocessError, OSError) as error:
                raise RuntimeError("text_input_incomplete: text may be partially typed and keyboard modifiers may have changed; inspect state before retrying") from error
            typed += len(chunk)
        if receipt is not None and stopped is None:
            wait_for_typed_text(receipt)
        elif receipt is not None:
            # Why: the remapped keycodes must outlive the typed prefix until an input method has read it.
            time.sleep(CLIPBOARD_PASTE_SETTLE_SECONDS)
    if stopped is not None:
        raise stopped


def text_selection(text):
    start = end = int(attempt(lambda: Atspi.Text.get_caret_offset(text), -1))
    selection_count = attempt(lambda: Atspi.Text.get_n_selections(text))
    if selection_count not in (0, 1):
        return None
    if selection_count == 1:
        selection = attempt(lambda: Atspi.Text.get_selection(text, 0))
        if selection is None or not 0 <= selection.start_offset < selection.end_offset:
            return None
        start, end = selection.start_offset, selection.end_offset
    if start < 0:
        return None
    original_count = attempt(lambda: Atspi.Text.get_character_count(text))
    if original_count is None or original_count < 0 or end > original_count:
        return None
    return start, end, original_count


def insert_focused_text(window, value):
    node = first_descendant(window, lambda candidate: has_state(candidate, Atspi.StateType.FOCUSED))
    return insert_text(node, value, "focusedText")


def insert_text(node, value, verified_property):
    # Why: EditableText needs no window focus and still works on Wayland, where key synthesis is a no-op.
    if node is None or not has_state(node, Atspi.StateType.EDITABLE):
        return None
    editable = attempt(node.get_editable_text_iface)
    text = text_iface(node)
    if editable is None or text is None:
        return None
    selection = text_selection(text)
    if selection is None:
        return None
    start, end, original_count = selection
    original = None
    if end > start:
        original = attempt(lambda: Atspi.Text.get_text(text, 0, original_count))
        if original is None or len(original) != original_count:
            return None
    inserted_count = original_count + len(value)
    if (not attempt(lambda: Atspi.EditableText.insert_text(editable, end, value, len(value.encode("utf-8"))), False)
            or attempt(lambda: Atspi.Text.get_character_count(text)) != inserted_count
            or attempt(lambda: Atspi.Text.get_text(text, end, end + len(value))) != value):
        raise RuntimeError("text_insertion_unconfirmed: text insertion did not confirm success; inspect state before retrying")
    # Why insert before deleting: an unsuccessful insert leaves the selected text intact.
    if end > start and (not attempt(lambda: Atspi.EditableText.delete_text(editable, start, end), False)
            or attempt(lambda: Atspi.Text.get_character_count(text)) != inserted_count - (end - start)
            or attempt(lambda: Atspi.Text.get_text(text, 0, inserted_count - (end - start)))
            != original[:start] + value + original[end:]):
        raise RuntimeError("text_replacement_incomplete: text was inserted but selection deletion did not confirm success; inspect state before retrying")
    caret = start + len(value)
    if attempt(lambda: Atspi.Text.get_caret_offset(text)) != caret:
        if (not attempt(lambda: Atspi.Text.set_caret_offset(text, caret), False)
                or attempt(lambda: Atspi.Text.get_caret_offset(text)) != caret):
            raise RuntimeError("text_caret_unconfirmed: text was inserted but caret movement did not confirm success; inspect state before retrying")
    action = {"path": "accessibility", "actionName": "insertText", "fallbackReason": None}
    readback = attempt(lambda: Atspi.Text.get_text(text, start, caret))
    if readback == value:
        action["verification"] = {"state": "verified", "property": verified_property}
    else:
        reason = "readback_unsupported" if readback is None else "accessibility_action_unasserted"
        action["verification"] = {"state": "unverified", "reason": reason}
    return action


def insert_element_text(node, saved, value):
    index = saved.get("index")
    if node is None:
        raise RuntimeError(f"element {index} changed since the last snapshot; run get-app-state again and use a fresh element index")
    action = insert_text(node, value, "elementText")
    # Why: typing at focus instead would put the text in whatever field has focus, not the requested one.
    if action is None:
        raise RuntimeError(f"element {index} text is not settable; click it, then run type-text without --element-index")
    return action


def paste_text(value):
    text = str(value)
    previous = read_clipboard()
    try:
        write_clipboard(text)
        hotkey("ctrl+v")
        # Why: X11 paste consumers may read the selection after the key event
        # returns, so keep the pasted text as the owner briefly before restore.
        time.sleep(CLIPBOARD_PASTE_SETTLE_SECONDS)
    finally:
        if previous is not None:
            write_clipboard(previous)
        else:
            # Why: if the clipboard had no readable prior value, do not leave
            # the agent-provided paste text in the user's system clipboard.
            write_clipboard("")


def read_clipboard():
    for command in (["wl-paste"], ["xclip", "-selection", "clipboard", "-o"], ["xsel", "--clipboard", "--output"]):
        if shutil.which(command[0]):
            try:
                result = subprocess.run(
                    command,
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=CLIPBOARD_COMMAND_TIMEOUT_SECONDS,
                )
            except subprocess.TimeoutExpired:
                continue
            if result.returncode == 0:
                return result.stdout
    return None


def write_clipboard(value):
    if shutil.which("wl-copy"):
        subprocess.run(
            ["wl-copy"],
            input=value,
            check=True,
            text=True,
            timeout=CLIPBOARD_COMMAND_TIMEOUT_SECONDS,
        )
        return
    for command in (["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]):
        if not shutil.which(command[0]):
            continue
        process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        if process.stdin is not None:
            process.stdin.write(value)
            process.stdin.close()
        time.sleep(CLIPBOARD_OWNER_SETTLE_SECONDS)
        if process.poll() not in (None, 0):
            raise RuntimeError(f"{command[0]} failed to set clipboard")
        return
    raise RuntimeError("paste_text requires wl-copy, xclip, or xsel")


def set_value(node, value):
    editable = attempt(node.get_editable_text_iface) if node is not None else None
    if editable is not None and attempt(lambda: Atspi.EditableText.set_text_contents(editable, str(value)), False):
        return True
    value_iface = attempt(node.get_value_iface) if node is not None else None
    if value_iface is not None:
        return bool(attempt(lambda: Atspi.Value.set_current_value(value_iface, float(value)), False))
    return False


def run_operation(operation):
    _x11_windows_by_pid.clear()
    tool = operation.get("tool")
    include_screenshot = not bool(operation.get("noScreenshot"))
    if tool == "handshake":
        return {"ok": True, "capabilities": handshake_response()}
    if tool == "list_apps":
        return {"ok": True, "apps": list_apps_response()}
    if tool == "list_windows":
        return {"ok": True, **list_windows_response(operation.get("app", ""))}
    if tool == "get_app_state":
        return {
            "ok": True,
            "snapshot": make_snapshot(
                operation.get("app", ""),
                include_screenshot,
                operation.get("windowId"),
                operation.get("windowIndex"),
                bool(operation.get("restoreWindow")),
                operation.get("root"),
            ),
        }

    app = find_app(operation.get("app", ""))
    _, window = choose_window(app, operation.get("windowId"), operation.get("windowIndex"))
    was_active = (has_state(window, Atspi.StateType.ACTIVE), any_window_active(app))
    saved = operation.get("element")
    node = find_element(app, saved)
    action = None

    def pointer_input(what, hint, points, send):
        points(Placement(app, window))  # Why first: a stale or off-window target is not a reason to ask for a raise.
        require_pointer_route(operation, what, hint)
        restore_pointer_window(app, window)
        with pointer_put_back():
            send(*points(Placement(app, window)))

    if tool == "click":
        preferred = preferred_action(node)
        click_count = (
            require_positive_integer(operation.get("click_count"), "click_count")
            if operation.get("click_count") is not None
            else 1
        )
        has_modifiers = bool(str(operation.get("modifiers") or "").strip())
        simple = not has_modifiers and operation.get("mouse_button", "left") == "left" and click_count <= 1
        semantic = simple and preferred is not None
        if semantic:
            names = action_names(node)
            name = (names[preferred] if preferred < len(names) else "") or "action"
            refuse_foreground_effect(app, node, window, name, True, operation)
        if semantic and perform_action(node, preferred):
            action = {"path": "accessibility", "actionName": name, "fallbackReason": None}
        else:
            action = select_in_parent(app, node) if simple else None
        if action is None:
            pointer_input(
                "this click", "Click an element by --element-index that has an accessibility action, or use set-value.",
                lambda placed: [window_point(placed, saved, operation.get("x"), operation.get("y"), node)],
                lambda point: click_at(*point, operation.get("mouse_button", "left"), click_count, operation.get("modifiers")),
            )
            action = {"path": "synthetic", "actionName": None, "fallbackReason": "actionUnsupported"}
    elif tool == "perform_secondary_action":
        if node is None:
            raise RuntimeError("stale element: the element is gone; run get-app-state again and use a fresh element index")
        wanted = str(operation.get("action", "")).lower()
        names = action_names(node)
        index = next((i for i, label in enumerate(names) if (label or attempt(lambda i=i: node.get_action_description(i), "")).lower() == wanted), None)
        if index is None:
            raise RuntimeError(f'{operation.get("action", "")} is not a valid secondary action')
        label = names[index] or wanted
        refuse_foreground_effect(app, node, window, label, compact_action(label) in {"click", "press", "activate", "toggle", "open"}, operation)
        if not perform_action(node, index):
            raise RuntimeError(f'{operation.get("action", "")} is not a valid secondary action')
        action = {"path": "accessibility", "actionName": label, "fallbackReason": None}
    elif tool == "scroll":
        action = scroll_without_pointer(window, node, Placement(app, window), operation.get("x"), operation.get("y"),
                                        operation.get("direction"), operation.get("pages"))
        if action is None:
            pointer_input(
                "scrolling", "This view exposes no scroll bar or scrollable document to scroll in the background.",
                lambda placed: [window_point(placed, saved, operation.get("x"), operation.get("y"), node)],
                lambda point: scroll_at(*point, operation.get("direction"), operation.get("pages")),
            )
            action = {"path": "synthetic", "actionName": "scroll", "fallbackReason": None}
    elif tool == "drag":
        from_node = find_element(app, operation.get("fromElement"))
        to_node = find_element(app, operation.get("toElement"))
        pointer_input(
            "dragging", "",
            lambda placed: [
                window_point(placed, operation.get("fromElement"), operation.get("from_x"), operation.get("from_y"), from_node),
                window_point(placed, operation.get("toElement"), operation.get("to_x"), operation.get("to_y"), to_node),
            ],
            drag_between,
        )
        action = {"path": "synthetic", "actionName": "drag", "fallbackReason": None}
    elif tool == "type_text":
        text = require_non_empty_string(operation.get("text"), "text")
        if saved:
            action = insert_element_text(node, saved, text)
        else:
            action = insert_focused_text(window, text)
        if action is None:
            require_keyboard_focus(app, window, operation, "type-text")
            type_text(text, window)
            action = {"path": "synthetic", "actionName": "typeText", "fallbackReason": None, "verification": {"state": "unverified", "reason": "synthetic_input"}}
    elif tool == "press_key":
        key = require_non_empty_string(operation.get("key"), "key")
        if is_enter_key(key) and (wayland_session() or not has_state(window, Atspi.StateType.ACTIVE)):
            action = activate_focused_entry(app, window)
        if action is None:
            require_keyboard_focus(app, window, operation, "press-key")
            press_key(key, window)
            action = {"path": "synthetic", "actionName": "pressKey", "fallbackReason": None, "verification": {"state": "unverified", "reason": "synthetic_input"}}
    elif tool == "hotkey":
        require_keyboard_focus(app, window, operation, "hotkey")
        hotkey(require_non_empty_string(operation.get("key"), "key"), window)
        action = {"path": "synthetic", "actionName": "hotkey", "fallbackReason": None, "verification": {"state": "unverified", "reason": "synthetic_input"}}
    elif tool == "paste_text":
        text = require_non_empty_string(operation.get("text"), "text")
        action = insert_focused_text(window, text)
        if action is None:
            require_keyboard_focus(app, window, operation, "paste-text")
            paste_text(text)
            action = {"path": "clipboard", "actionName": "paste", "fallbackReason": None, "verification": {"state": "unverified", "reason": "clipboard_paste"}}
    elif tool == "set_value":
        if not set_value(node, operation.get("value", "")):
            raise RuntimeError("element value is not settable")
        action = {"path": "accessibility", "actionName": "setValue", "fallbackReason": None}
    else:
        raise RuntimeError("unknown tool: " + str(tool))

    try:
        snapshot = make_snapshot(
            operation.get("app", ""),
            include_screenshot,
            operation.get("windowId"),
            operation.get("windowIndex"),
        )
    except Exception:
        if operation.get("windowId") is None and operation.get("windowIndex") is None:
            raise
        action.setdefault("verification", {"state": "unverified", "reason": "window_changed"})
        snapshot = make_snapshot(operation.get("app", ""), include_screenshot, None, None)

    # Why measured: synthetic input needs the window in front, and an app can activate itself after an AT-SPI action.
    took_foreground = ((not was_active[0] and has_state(window, Atspi.StateType.ACTIVE))
                       or (not was_active[1] and any_window_active(app)))
    action["delivery"] = "background" if action["path"] == "accessibility" and not took_foreground else "foreground"
    return {"ok": True, "action": action, "snapshot": snapshot}


def terminate_bridge(_signal, _frame):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    sys.exit(143)


def main():
    signal.signal(signal.SIGTERM, terminate_bridge)
    try:
        ensure_desktop_bus()
        with open(sys.argv[1], "r", encoding="utf-8") as handle:
            operation = json.load(handle)
        print(json.dumps(run_operation(operation), separators=(",", ":")))
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, separators=(",", ":")))


if __name__ == "__main__":
    main()

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
import subprocess
import sys
import time
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
    gi.require_version("GdkPixbuf", "2.0")
    from gi.repository import Gdk, GdkPixbuf
except (ImportError, ValueError):
    Gdk = None
    GdkPixbuf = None
from gi.repository import Atspi

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
    state_set = attempt(node.get_state_set)
    return bool(state_set is not None and attempt(lambda: state_set.contains(state), False))


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

    def rect(self, node):
        return screen_rect(node, self.read)


def screen_rect(node, read=attempt):
    component = read(node.get_component_iface)
    if component is None:
        return None
    rect = read(lambda: Atspi.Component.get_extents(component, Atspi.CoordType.SCREEN))
    if rect is None or rect.width <= 0 or rect.height <= 0:
        return None
    return Rect(float(rect.x), float(rect.y), float(rect.width), float(rect.height))


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


def restore_window(app, window=None):
    target = window if window is not None else choose_window(app)[1]
    if has_state(target, Atspi.StateType.ACTIVE):
        return
    component = attempt(target.get_component_iface)
    if component is not None:
        attempt(lambda: Atspi.Component.grab_focus(component), False)
    if wait_window_focused(target):
        return
    if os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland":
        return
    windows = windows_for(app)
    if len(windows) != 1 or windows[0][1] != target:
        return
    pid = pid_of(app)
    xdotool = shutil.which("xdotool")
    if not pid or not xdotool:
        return
    try:
        result = subprocess.run([xdotool, "search", "--pid", str(pid)],
                                check=False, capture_output=True, text=True, timeout=2)
        ids = result.stdout.split()
        if result.returncode != 0 or any(not value.isdigit() or int(value) <= 0 for value in ids):
            return
        managed_ids = attempt(lambda: {str(GdkX11.X11Window.get_xid(item))
                                      for item in Gdk.Screen.get_default().get_window_stack()})
        if managed_ids is None or any(not value.isdigit() or int(value) <= 0 for value in managed_ids):
            return
        ids = [value for value in ids if value in managed_ids]
        if len(ids) != 1:
            return
        subprocess.run([xdotool, "windowactivate", "--sync", ids[0]], check=False,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2)
    except (OSError, subprocess.TimeoutExpired):
        return


def wait_window_focused(window):
    deadline = time.monotonic() + 0.5
    while time.monotonic() < deadline:
        if has_state(window, Atspi.StateType.ACTIVE):
            return True
        time.sleep(0.05)
    return has_state(window, Atspi.StateType.ACTIVE)


def require_keyboard_focus(window, operation):
    if has_state(window, Atspi.StateType.ACTIVE):
        return
    if operation.get("restoreWindow"):
        if wait_window_focused(window):
            return
        raise RuntimeError("window_not_focused: keyboard input requires the target window to be focused; restoreWindow was requested but the target window is still not focused; bring it forward manually or check desktop permissions")
    raise RuntimeError("window_not_focused: keyboard input requires the target window to be focused; retry with --restore-window")


def restore_pointer_window(app, window):
    restore_window(app, window)
    if not wait_window_focused(window):
        raise RuntimeError("window_not_focused: window restoration did not focus the target window; no pointer input was sent")
    return screen_rect(window)


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


def record(node, index, path):
    role = role_of(node)
    return {
        "index": index,
        "runtimeId": path,
        "automationId": accessible_id(node),
        "name": name_of(node),
        "controlType": role,
        "localizedControlType": role,
        "className": str(attempt(node.get_toolkit_name, "") or ""),
        "value": string_value(node),
        "isSelected": has_state(node, Atspi.StateType.SELECTED),
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

    def walk(node, depth, path):
        nonlocal next_index
        if len(records) >= MAX_NODES or depth > MAX_DEPTH:
            truncation["truncated"] = True
            if depth > MAX_DEPTH:
                truncation["maxDepthReached"] = True
            return
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
            for child_index, child in child_items:
                walk(child, depth, path + [child_index])
            return
        records.append(item)
        next_index += 1
        if geometry_nodes is not None:
            geometry_nodes[id(item)] = node
        role_label = item["localizedControlType"] or item["controlType"]
        line = f'{item["index"]} {role_label} {sanitize_text(title)}'.rstrip()
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
        for child_index, child in child_items:
            walk(child, depth + 1, path + [child_index])
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


def capture_png(rect):
    if Gdk is None or GdkPixbuf is None or rect is None or os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland":
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
    bounds = screen_rect(window)
    showing = has_state(window, Atspi.StateType.SHOWING)
    return {
        "index": index,
        "app": app_json(app),
        "id": None,
        "title": name_of(window),
        "x": round(bounds.x) if bounds else None,
        "y": round(bounds.y) if bounds else None,
        "width": max(0, round(bounds.width if bounds else 0)),
        "height": max(0, round(bounds.height if bounds else 0)),
        "isMinimized": not showing,
        "isOffscreen": not showing,
        "screenIndex": None,
        "platform": {"backend": "at-spi", "runtimeId": [index], "role": role_of(window)},
    }


def make_snapshot(query, include_screenshot, window_id=None, window_index=None, restore=False):
    app = find_app(query)
    window_index, window = choose_window(app, window_id, window_index)
    if restore:
        restore_window(app, window)
        window_index, window = choose_window(app, window_id, window_index)
    bounds = screen_rect(window)
    geometry_nodes = {}
    records, lines, truncation = render_accessibility_tree(
        window,
        [window_index],
        compact_browser_tabs=is_browser_app(query, app),
        geometry_nodes=geometry_nodes,
    )
    focused = focused_summary(window)
    selection = selected_text(window)
    app_info = app_json(app)
    window_title = name_of(window)
    screenshot = capture_png(bounds) if include_screenshot else None
    geometry = GeometryReader()
    for item in records:
        node = geometry_nodes[id(item)]
        rect = bounds if node is window else geometry.rect(node)
        if rect is not None and bounds is not None:
            rect = Rect(rect.x - bounds.x, rect.y - bounds.y, rect.width, rect.height)
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
    is_wayland = os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland"
    has_hotkey = shutil.which("xdotool") is not None and not is_wayland
    has_clipboard = any(shutil.which(command) for command in ("wl-copy", "xclip", "xsel"))
    has_screenshot = Gdk is not None and GdkPixbuf is not None and not is_wayland
    return {
        "platform": "linux",
        "provider": "orca-computer-use-linux",
        "providerVersion": "1.0.0",
        "protocolVersion": 1,
        "supports": {
            "apps": {"list": True, "bundleIds": False, "pids": True},
            "windows": {"list": True, "targetById": False, "targetByIndex": True, "focus": False, "moveResize": False},
            "observation": {"screenshot": has_screenshot, "annotatedScreenshot": False, "elementFrames": True, "ocr": False},
            "actions": {
                "click": True,
                "typeText": True,
                "pressKey": True,
                "hotkey": has_hotkey,
                "pasteText": has_clipboard,
                "scroll": True,
                "drag": True,
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
        if len(result) >= MAX_NODES:
            return
        result.append(node)
        for _, child in children(node):
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


def screen_point(window_rect, saved_element=None, x=None, y=None, node=None):
    rect = screen_rect(node) if node is not None else None
    if rect is not None:
        return rect.x + rect.width / 2, rect.y + rect.height / 2
    if saved_element is not None:
        raise RuntimeError("stale element frame; run get-app-state again and use a fresh element index")
    if window_rect is None or x is None or y is None:
        raise RuntimeError("coordinate action requires a visible window and coordinates")
    return window_rect.x + float(x), window_rect.y + float(y)


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
        Atspi.generate_mouse_event(round(x), round(y), down)
        time.sleep(0.03)
        Atspi.generate_mouse_event(round(x), round(y), up)


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
    is_wayland = os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland"
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
        Atspi.generate_mouse_event(round(x), round(y), down)
        time.sleep(0.03)
        Atspi.generate_mouse_event(round(x), round(y), up)


def drag_between(start, end):
    Atspi.generate_mouse_event(round(start[0]), round(start[1]), "abs")
    Atspi.generate_mouse_event(round(start[0]), round(start[1]), "b1p")
    for step in range(1, 13):
        x = start[0] + (end[0] - start[0]) * step / 12
        y = start[1] + (end[1] - start[1]) * step / 12
        Atspi.generate_mouse_event(round(x), round(y), "abs")
        time.sleep(0.02)
    Atspi.generate_mouse_event(round(end[0]), round(end[1]), "b1r")


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
    Atspi.generate_keyboard_event(Gdk.keyval_from_name(name), None, Atspi.KeySynthType.SYM)


def hotkey(raw, window=None):
    key_spec = re.sub(r"(?i)commandorcontrol|cmdorctrl", "ctrl", str(raw))
    if "+" in key_spec:
        # xdotool treats an upper-case letter as its shifted keysym, so ctrl+A would press ctrl+shift+a.
        key_spec = "+".join(part.lower() if len(part) == 1 else part for part in key_spec.split("+"))
    xdotool = shutil.which("xdotool")
    if xdotool:
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


def type_text(value, window=None):
    text = str(value)
    xdotool = shutil.which("xdotool")
    if (os.environ.get("XDG_SESSION_TYPE", "").lower() == "wayland"
            or (not xdotool and text.isascii())):
        Atspi.generate_keyboard_event(0, text, Atspi.KeySynthType.STRING)
        return
    if not xdotool:
        raise RuntimeError("unsupported capability: synthetic Unicode text requires xdotool on X11")
    # Keep normal typing below both the child and provider watchdogs.
    if len(text) > 600:
        raise RuntimeError("unsupported capability: synthetic text is limited to 600 characters; split the text or use paste_text")
    Atspi.set_timeout(ATSPI_METHOD_TIMEOUT_MS, ATSPI_STARTUP_TIMEOUT_MS)
    with temporary_x11_keymap(text, lambda: synthetic_text_receipt(window, text)) as receipt:
        try:
            # A fresh xdotool reads the stable mappings, held until the target consumes its keys.
            subprocess.run(
                [xdotool, "type", "--clearmodifiers", "--delay", "12", "--file", "-"],
                input=text, encoding="utf-8", env={**os.environ, "LC_ALL": "C.UTF-8"},
                check=True, capture_output=True, timeout=10,
            )
        except (subprocess.SubprocessError, OSError) as error:
            raise RuntimeError("text_input_incomplete: text may be partially typed and keyboard modifiers may have changed; inspect state before retrying") from error
        if receipt is not None:
            wait_for_typed_text(receipt)


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
    # Why: EditableText needs no window focus and still works on Wayland, where key synthesis is a no-op.
    node = first_descendant(window, lambda candidate: has_state(candidate, Atspi.StateType.FOCUSED))
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
    if attempt(lambda: Atspi.Text.get_text(text, start, caret)) == value:
        action["verification"] = {"state": "verified", "property": "focusedText", "expected": value}
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
            ),
        }

    app = find_app(operation.get("app", ""))
    _, window = choose_window(app, operation.get("windowId"), operation.get("windowIndex"))
    if operation.get("restoreWindow"):
        restore_window(app, window)
        _, window = choose_window(app, operation.get("windowId"), operation.get("windowIndex"))
    if tool in {"press_key", "hotkey"}:
        require_keyboard_focus(window, operation)
    bounds = screen_rect(window)
    saved = operation.get("element")
    node = find_element(app, saved)
    from_node = find_element(app, operation.get("fromElement"))
    to_node = find_element(app, operation.get("toElement"))
    action = None

    if tool == "click":
        preferred = preferred_action(node)
        click_count = (
            require_positive_integer(operation.get("click_count"), "click_count")
            if operation.get("click_count") is not None
            else 1
        )
        has_modifiers = bool(str(operation.get("modifiers") or "").strip())
        handled = not has_modifiers and operation.get("mouse_button", "left") == "left" and click_count <= 1 and perform_action(node, preferred)
        if not handled:
            # Why: pointer clicks are synthetic global input; AT-SPI actions need no focus.
            bounds = restore_pointer_window(app, window)
            click_at(
                *screen_point(bounds, saved, operation.get("x"), operation.get("y"), node),
                operation.get("mouse_button", "left"),
                click_count,
                operation.get("modifiers"),
            )
            action = {"path": "synthetic", "actionName": None, "fallbackReason": "actionUnsupported"}
        else:
            labels = action_labels(node)
            action = {"path": "accessibility", "actionName": labels[preferred] if preferred is not None and preferred < len(labels) else "action", "fallbackReason": None}
    elif tool == "perform_secondary_action":
        wanted = str(operation.get("action", "")).lower()
        for index, label in enumerate(action_labels(node)):
            if label.lower() == wanted and perform_action(node, index):
                action = {"path": "accessibility", "actionName": label, "fallbackReason": None}
                break
        else:
            raise RuntimeError(f'{operation.get("action", "")} is not a valid secondary action')
    elif tool == "scroll":
        # Why: pointer wheel events should land in the requested app window even
        # when another desktop window is currently foregrounded.
        bounds = restore_pointer_window(app, window)
        scroll_at(*screen_point(bounds, saved, operation.get("x"), operation.get("y"), node), operation.get("direction"), operation.get("pages"))
        action = {"path": "synthetic", "actionName": "scroll", "fallbackReason": None}
    elif tool == "drag":
        # Why: pointer drags are synthetic global input, so activate the target
        # window before using cached coordinates from its accessibility tree.
        bounds = restore_pointer_window(app, window)
        drag_between(
            screen_point(bounds, operation.get("fromElement"), operation.get("from_x"), operation.get("from_y"), from_node),
            screen_point(bounds, operation.get("toElement"), operation.get("to_x"), operation.get("to_y"), to_node),
        )
        action = {"path": "synthetic", "actionName": "drag", "fallbackReason": None}
    elif tool == "type_text":
        text = require_non_empty_string(operation.get("text"), "text")
        action = insert_focused_text(window, text)
        if action is None:
            require_keyboard_focus(window, operation)
            type_text(text, window)
            action = {"path": "synthetic", "actionName": "typeText", "fallbackReason": None, "verification": {"state": "unverified", "reason": "synthetic_input"}}
    elif tool == "press_key":
        press_key(require_non_empty_string(operation.get("key"), "key"), window)
        action = {"path": "synthetic", "actionName": "pressKey", "fallbackReason": None, "verification": {"state": "unverified", "reason": "synthetic_input"}}
    elif tool == "hotkey":
        hotkey(require_non_empty_string(operation.get("key"), "key"), window)
        action = {"path": "synthetic", "actionName": "hotkey", "fallbackReason": None, "verification": {"state": "unverified", "reason": "synthetic_input"}}
    elif tool == "paste_text":
        text = require_non_empty_string(operation.get("text"), "text")
        action = insert_focused_text(window, text)
        if action is None:
            require_keyboard_focus(window, operation)
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

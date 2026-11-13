from contextlib import ExitStack, contextmanager, nullcontext
import importlib.util
import json
import shutil
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch


class FakeStateType:
    PROTECTED = 1
    SELECTED = 2
    ACTIVE = 3
    SHOWING = 4
    FOCUSED = 5
    EDITABLE = 6
    ENABLED = 7
    SENSITIVE = 8
    HAS_POPUP = 9
    MULTI_LINE = 10
    VERTICAL = 11
    HORIZONTAL = 12
    MULTISELECTABLE = 13


class FakeStateSet:
    def __init__(self, *states):
        self.states = set(states)

    def contains(self, state):
        return state in self.states


class FakeText:
    @staticmethod
    def get_character_count(node):
        return len(node.value)

    @staticmethod
    def get_text(node, start, end):
        return node.value[start:end]

    @staticmethod
    def get_caret_offset(node):
        return node.caret

    @staticmethod
    def set_caret_offset(node, offset):
        node.caret = offset
        return True

    @staticmethod
    def get_n_selections(node):
        return 1 if node.selection else 0

    @staticmethod
    def get_selection(node, _):
        return types.SimpleNamespace(start_offset=node.selection[0], end_offset=node.selection[1])


class FakeEditableText:
    @staticmethod
    def insert_text(node, position, text, length):
        inserted = text.encode("utf-8")[:length].decode("utf-8")
        node.value = node.value[:position] + inserted + node.value[position:]
        return True

    @staticmethod
    def delete_text(node, start, end):
        node.value = node.value[:start] + node.value[end:]
        node.selection = None
        return True


def load_runtime():
    gi = types.ModuleType("gi")
    repository = types.ModuleType("gi.repository")
    gi.require_version = lambda *_: None
    repository.Atspi = types.SimpleNamespace(StateType=FakeStateType, Text=FakeText, EditableText=FakeEditableText)
    repository.Gdk = types.SimpleNamespace()
    repository.GdkPixbuf = types.SimpleNamespace()
    gi.repository = repository
    sys.modules["gi"] = gi
    sys.modules["gi.repository"] = repository

    path = Path(__file__).with_name("runtime.py")
    spec = importlib.util.spec_from_file_location("orca_linux_runtime_test", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


runtime = load_runtime()


class FakeAccessible:
    def __init__(self, role, name="", value="", children=()):
        self.role = role
        self.name = name
        self.value = value
        self.children = list(children)
        self.parent = None
        for child in self.children:
            child.parent = self

    def get_parent(self):
        return self.parent

    def get_index_in_parent(self):
        return self.parent.children.index(self)

    def get_child_count(self):
        return len(self.children)

    def get_child_at_index(self, index):
        return self.children[index]

    def get_role_name(self):
        return self.role

    def get_name(self):
        return self.name

    def get_accessible_id(self):
        return ""

    def get_toolkit_name(self):
        return "fake"

    def get_component_iface(self):
        return None

    def get_state_set(self):
        return None

    def get_n_actions(self):
        return 0

    def is_text(self):
        return bool(self.value)

    def get_text_iface(self):
        return self if self.value else None

    def get_value_iface(self):
        return None


class SnapshotFixture(ExitStack):
    def __init__(self, root, app_name="Fixture"):
        super().__init__()
        self.root = root
        self.app = FakeAccessible("application", app_name, children=[root])
        self.app.get_process_id = lambda: 42
        self.clock = 0.0
        self.timeout = (800, 15000)
        self.delays = {}
        self.restore = lambda: None
        self.pointer = None
        self.bounds = {node: runtime.Rect(100 + i * 10, 200 + i * 20, 300, 400)
                       for i, node in enumerate(runtime.all_nodes(root))}
        for node in self.bounds:
            node.get_component_iface = lambda node=node: node

    def __enter__(self):
        for obj, name, value in (
            (runtime, "desktop_apps", lambda: iter([self.app])),
            (runtime.time, "monotonic", lambda: self.clock),
            (runtime.Atspi, "set_timeout", self.set_timeout),
            (runtime.Atspi, "Component", types.SimpleNamespace(get_extents=self.extents)),
            (runtime.Atspi, "CoordType", types.SimpleNamespace(SCREEN=0, WINDOW=1)),
            (runtime, "capture_png", self.capture),
            (runtime, "restore_window", lambda *_: self.restore()),
            (runtime, "x11_pointer_state", lambda: self.pointer),
        ):
            self.enter_context(patch.object(obj, name, value, create=True))
        return self

    def set_timeout(self, method, startup):
        self.timeout = (method, startup)

    def extents(self, node, _):
        method, startup = self.timeout
        allowance = max(method, startup - self.clock * 1000) / 1000
        delay = self.delays.get(node, 0)
        self.clock += min(delay, allowance)
        if delay > allowance:
            raise TimeoutError("unresponsive geometry")
        return self.bounds.get(node)

    def capture(self, bounds, *_):
        self.clock += 1
        return {"base64": json.dumps(bounds.to_json())} if bounds else None


class WaylandScreenshotTest(unittest.TestCase):
    def setUp(self):
        self.context = ExitStack()
        self.addCleanup(self.context.close)
        self.context.enter_context(patch.dict(runtime.os.environ, {
            "XDG_SESSION_TYPE": "wayland", "HYPRLAND_INSTANCE_SIGNATURE": "fixture", "SWAYSOCK": ""
        }))
        self.context.enter_context(patch.object(runtime.shutil, "which", side_effect=lambda name: "/usr/bin/" + name))
        self.app = types.SimpleNamespace(get_process_id=lambda: 42)
        self.window = types.SimpleNamespace(get_name=lambda: "Editor")
        self.clients = [{"pid": 42, "title": "Editor", "mapped": True, "hidden": False,
                         "workspace": {"id": 2}, "at": [-800, 40], "size": [640, 480]}]
        self.monitors = [{"activeWorkspace": {"id": 1}, "specialWorkspace": {"id": 0}},
                         {"activeWorkspace": {"id": 2}, "specialWorkspace": {"id": 0}}]
        self.commands = []
        self.context.enter_context(patch.object(runtime.subprocess, "run", side_effect=self.run_native))

    def run_native(self, command, **options):
        self.commands.append(command)
        if command[0].endswith("hyprctl"):
            options["stdout"].write(json.dumps(self.monitors if command[-1] == "monitors" else self.clients).encode())
        else:
            options["stdout"].write(b"png")
        return types.SimpleNamespace(returncode=0)

    def test_ambiguous_missing_and_hidden_windows_never_capture_another_region(self):
        for clients in (
            [],
            self.clients * 2,
            [{**self.clients[0], "hidden": True}],
            [{**self.clients[0], "workspace": {"id": 3}}],
            [{**self.clients[0], "size": [700, 480]}],
        ):
            with self.subTest(clients=clients):
                self.clients = clients
                self.commands.clear()
                result = runtime.capture_png(runtime.Rect(0, 0, 640, 480), self.app, self.window)
                self.assertEqual(result["error"]["code"], "screenshot_failed")
                self.assertFalse(any(command[0].endswith("grim") for command in self.commands))

    def test_sway_nested_floating_window_geometry(self):
        tree = {"nodes": [{"floating_nodes": [{"pid": 42, "name": "Editor",
                "rect": {"x": 98, "y": 20, "width": 644, "height": 512},
                "window_rect": {"x": 2, "y": 30, "width": 640, "height": 480}, "visible": True}]}]}
        def sway(command, **options):
            options["stdout"].write(json.dumps(tree).encode())
            return types.SimpleNamespace(returncode=0)
        with patch.dict(runtime.os.environ, {"HYPRLAND_INSTANCE_SIGNATURE": "", "SWAYSOCK": "fixture"}), \
             patch.object(runtime.subprocess, "run", side_effect=sway):
            rect, error = runtime.wayland_window_rect("sway", self.app, self.window)
            tree["nodes"][0]["floating_nodes"][0]["visible"] = False
            hidden, hidden_error = runtime.wayland_window_rect("sway", self.app, self.window)
        self.assertIsNone(error)
        self.assertEqual(rect.to_json(), {"x": 100, "y": 50, "width": 640, "height": 480})
        self.assertIsNone(hidden)
        self.assertIsNotNone(hidden_error)

class FakePixbuf:
    def __init__(self, width, height, calls):
        self.width, self.height, self.calls = width, height, calls

    def get_width(self):
        return self.width

    def get_height(self):
        return self.height

    def new_subpixbuf(self, x, y, width, height):
        self.calls.append(("crop", x, y, width, height))
        return FakePixbuf(width, height, self.calls)

    def fill(self, _):
        self.calls.append(("fill", self.width, self.height))

    def copy_area(self, x, y, width, height, _, to_x, to_y):
        self.calls.append(("copy", x, y, width, height, to_x, to_y))

    def scale_simple(self, width, height, _):
        self.calls.append(("scale", width, height))
        return FakePixbuf(width, height, self.calls)

    def save_to_bufferv(self, *_):
        return True, b"png"


class KWinScreenshotTest(unittest.TestCase):
    def setUp(self):
        self.app = types.SimpleNamespace(get_process_id=lambda: 42)
        self.window = types.SimpleNamespace(get_name=lambda: "Editor")
        self.target = {"pid": 42, "caption": "Editor", "captionNormal": "Editor", "stackingOrder": 3, "shown": True,
                       "client": [100, 50, 400, 300], "buffer": [90, 40, 420, 320], "frame": [100, 20, 400, 330],
                       "screen": [-1280, 0, 2560, 800]}
        self.reports = []
        self.portal_calls = []
        self.pixbuf_calls = []
        self.context = ExitStack()
        self.addCleanup(self.context.close)
        for name, value in (
            ("wayland_session", lambda: True),
            ("wayland_screenshot_backend", lambda: "kwin"),
            ("session_bus", lambda: "bus"),
            ("kwin_layout", lambda _: self.reports.pop(0) if len(self.reports) > 1 else self.reports[0]),
            ("portal_screenshot_png", self.portal),
            ("decode_png", lambda _: FakePixbuf(5120, 1600, self.pixbuf_calls)),
            ("GdkPixbuf", types.SimpleNamespace(
                InterpType=types.SimpleNamespace(BILINEAR=0), Colorspace=types.SimpleNamespace(RGB=0),
                Pixbuf=types.SimpleNamespace(new=lambda _c, _a, _b, width, height: FakePixbuf(width, height, self.pixbuf_calls)))),
        ):
            self.context.enter_context(patch.object(runtime, name, value))

    def portal(self, _):
        self.portal_calls.append(True)
        return b"desktop"

    def capture(self, *windows, bounds=(400, 300)):
        self.reports = [{"workspace": [-1280, 0, 2560, 800], "windows": list(windows)}]
        return runtime.capture_png(runtime.Rect(0, 0, *bounds), self.app, self.window)

    def test_windows_kwin_cannot_place_never_reach_the_portal(self):
        cover = {**self.target, "pid": 7, "caption": "Other", "captionNormal": "Other", "stackingOrder": 4,
                 "frame": [450, 300, 200, 200]}
        for windows in (
            [self.target, dict(self.target)],
            [{**self.target, "shown": False}],
            [{**self.target, "client": [100, 50, 500, 300]}],
            [{**self.target, "screen": [0, 400, 640, 400]}],
            [self.target, cover],
        ):
            with self.subTest(windows=windows):
                self.portal_calls.clear()
                result = self.capture(*windows)
                self.assertEqual(result["error"]["code"], "screenshot_failed")
                self.assertEqual(self.portal_calls, [])

    def test_crop_maps_the_matching_kwin_rectangle_into_the_scaled_workspace_image(self):
        below = {**self.target, "pid": 7, "caption": "Other", "stackingOrder": 1, "frame": [0, 0, 800, 800]}
        menu = {**self.target, "caption": "Menu", "captionNormal": "Menu", "stackingOrder": 5, "ownedPopup": True,
                "frame": [150, 80, 100, 200]}
        result = self.capture(self.target, below, menu)
        self.assertNotIn("error", result)
        self.assertEqual(self.pixbuf_calls, [("crop", 2760, 100, 800, 600), ("scale", 400, 300)])
        self.pixbuf_calls.clear()
        # Client-side decorations: the toolkit reports the buffer (shadow included), not the content rectangle.
        self.capture(self.target, bounds=(420, 320))
        self.assertEqual(self.pixbuf_calls, [("crop", 2740, 80, 840, 640), ("scale", 420, 320)])
        self.pixbuf_calls.clear()
        # Partly left of the leftmost screen: full window size, only the shown part copied at its offset.
        self.capture({**self.target, "client": [-1380, 50, 400, 300]})
        self.assertEqual(self.pixbuf_calls, [("fill", 800, 600), ("copy", 0, 100, 600, 600, 200, 0), ("scale", 400, 300)])

    def test_window_that_moves_while_the_portal_answers_is_not_cropped(self):
        moved = {"workspace": [-1280, 0, 2560, 800], "windows": [{**self.target, "client": [120, 50, 400, 300]}]}
        self.reports = [{"workspace": [-1280, 0, 2560, 800], "windows": [self.target]}, moved]
        result = runtime.capture_png(runtime.Rect(0, 0, 400, 300), self.app, self.window)
        self.assertEqual(result["error"]["code"], "screenshot_failed")
        self.assertEqual(self.pixbuf_calls, [])


@unittest.skipIf(sys.platform == "win32", "the Linux bridge reads portal files with POSIX flags")
class PortalFileTest(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.directory)
        self.file = self.directory / "Screenshot 1.png"
        self.file.write_bytes(b"png")

    def test_reads_and_removes_only_a_new_file_the_portal_named(self):
        uri = self.file.as_uri()
        self.assertEqual(runtime.take_portal_file(uri, time.time()), b"png")
        self.assertFalse(self.file.exists())

        self.file.write_bytes(b"png")
        with self.assertRaises(ValueError):
            runtime.take_portal_file(uri, time.time() + 60)
        self.assertTrue(self.file.exists())

        link = self.directory / "link.png"
        link.symlink_to(self.file)
        with self.assertRaises(OSError):
            runtime.take_portal_file(link.as_uri(), time.time())
        self.assertTrue(link.is_symlink() and self.file.exists())


class RuntimeRenderTest(unittest.TestCase):

    def test_focus_search_keeps_transient_accessible_wrappers_alive(self):
        class TransientNode:
            def __init__(self, depth):
                self.depth = depth

            def get_child_count(self):
                return int(self.depth < 30)

            def get_child_at_index(self, _):
                return TransientNode(self.depth + 1)

        focused = runtime.first_descendant(TransientNode(0), lambda node: node.depth == 30)
        self.assertIsNotNone(focused)
        self.assertEqual(focused.depth, 30)


    def test_window_only_protection_preserves_completed_semantic_action(self):
        button = FakeAccessible("button", "Continue")
        effects = []
        button.get_state_set = lambda: FakeStateSet(FakeStateType.ENABLED)
        button.get_n_actions = lambda: 1
        button.get_action_name = lambda _: "click"
        def click(_):
            effects.append("clicked")
            button.value = "Completed"
            return True
        button.do_action = click
        with SnapshotFixture(FakeAccessible("frame", "Editor", children=[button])) as fixture:
            fixture.delays[button] = 20
            snapshot = runtime.make_snapshot("Fixture", False)
            self.assertIsNone(snapshot["elements"][1]["frame"])
            fixture.app.children.append(FakeAccessible("label", "Bitwarden integration"))
            result = runtime.run_operation({"tool": "click", "app": "Fixture", "windowIndex": 0,
                                            "element": snapshot["elements"][1], "noScreenshot": True})
            self.assertEqual(effects, ["clicked"])
            self.assertTrue(result["ok"])
            self.assertEqual(result["action"]["path"], "accessibility")
            self.assertEqual(result["snapshot"]["elements"][1]["value"], "Completed")
            fixture.root.name = "Bitwarden vault"
            fixture.bounds[fixture.root] = None
            with self.assertRaisesRegex(RuntimeError, "appBlocked"):
                runtime.run_operation({"tool": "click", "app": "Fixture"})
            self.assertEqual(effects, ["clicked"])

    def test_pointer_input_refuses_without_restore_and_raises_only_a_valid_target(self):
        operations = (
            {"tool": "click", "x": 5, "y": 6},
            {"tool": "scroll", "x": 5, "y": 6, "direction": "down", "pages": 1},
            {"tool": "drag", "from_x": 5, "from_y": 6, "to_x": 25, "to_y": 26},
        )
        cases = (
            {"name": "no restore flag", "restore": False, "error": "background_unavailable"},
            {"name": "target outside the window", "restore": True, "offset": 1000, "error": "outside the target window"},
            {"name": "restore did not activate", "restore": True, "activates": False, "error": "window_not_focused"},
            {"name": "restored", "restore": True, "activates": True},
        )
        for operation in operations:
            for case in cases:
                with self.subTest(tool=operation["tool"], case=case["name"]), SnapshotFixture(
                    FakeAccessible("frame", "Editor")
                ) as fixture:
                    restored, pointer_calls, moves = [], [], []
                    fixture.pointer = (700, 800, 0)
                    fixture.root.get_state_set = lambda: FakeStateSet(
                        *([FakeStateType.ACTIVE] if case.get("activates") and restored else [])
                    )
                    def restore():
                        restored.append(True)
                        fixture.bounds[fixture.root] = runtime.Rect(500, 200, 300, 400)
                    fixture.restore = restore
                    def sleep(seconds):
                        fixture.clock += seconds
                    offset = case.get("offset", 0)
                    request = {key: value + offset if key.endswith(("x", "y")) else value for key, value in operation.items()}
                    request.update({"app": "Fixture", "noScreenshot": True, "restoreWindow": case["restore"]})
                    with patch.object(runtime.time, "sleep", sleep), \
                         patch.object(runtime.Atspi, "generate_mouse_event", lambda *args: moves.append(args), create=True), \
                         patch.object(runtime, "click_at", lambda *args: pointer_calls.append(args[:2])), \
                         patch.object(runtime, "scroll_at", lambda *args: pointer_calls.append(args[:2])), \
                         patch.object(runtime, "drag_between", lambda start, end: pointer_calls.extend((start, end))):
                        if "error" in case:
                            with self.assertRaisesRegex(RuntimeError, case["error"]):
                                runtime.run_operation(request)
                            self.assertEqual(pointer_calls, [])
                            self.assertEqual(restored, [True] if case.get("activates") is False else [])
                        else:
                            result = runtime.run_operation(request)
                            self.assertEqual(pointer_calls, [(505, 206), (525, 226)] if operation["tool"] == "drag" else [(505, 206)])
                            self.assertEqual(moves, [(700, 800, "abs")])
                            self.assertEqual(result["action"]["delivery"], "foreground")

    def test_background_click_refuses_controls_that_take_the_foreground(self):
        cases = (
            ("menu bar entry", "gtk", "3.24", "menu item", "Settings", ["click", "ShowMenu"], (), True),
            ("dialog opener", "Qt", "6.6", "push button", "Configure Kate...", ["Press"], (), True),
            ("dialog opener on GTK 3", "gtk", "3.24", "push button", "Test…", ["click"], (), False),
            ("popup opener", "gtk", "4.14", "combo box", "Degrees", ["click"], (FakeStateType.HAS_POPUP,), True),
            ("popup opener with Selection", "gtk", "4.14", "combo box", "Output", ["click"], (FakeStateType.HAS_POPUP, "selection"), False),
            ("plain button", "Qt", "6.6", "push button", "Save", ["Press", "SetFocus"], (), False),
        )
        for name, toolkit, version, role, label, actions, traits, refused in cases:
            for restore in (False, True):
                button = FakeAccessible(role, label)
                effects = []
                button.get_state_set = lambda traits=traits: FakeStateSet(FakeStateType.ENABLED, *[t for t in traits if t != "selection"])
                button.get_selection_iface = lambda traits=traits: button if "selection" in traits else None
                button.get_n_actions = lambda actions=actions: len(actions)
                button.get_action_name = lambda index, actions=actions: actions[index]
                button.do_action = lambda index: effects.append(index) or True
                with self.subTest(case=name, restore=restore), SnapshotFixture(FakeAccessible("frame", "Editor", children=[button])) as fixture:
                    restored = []
                    fixture.restore = lambda: restored.append(True)
                    fixture.app.get_toolkit_name = lambda toolkit=toolkit: toolkit
                    fixture.app.get_toolkit_version = lambda version=version: version
                    element = runtime.make_snapshot("Fixture", False)["elements"][1]
                    request = {"tool": "click", "app": "Fixture", "element": element, "noScreenshot": True, "restoreWindow": restore}
                    if refused and not restore:
                        with self.assertRaisesRegex(RuntimeError, "background_unavailable"):
                            runtime.run_operation(request)
                        self.assertEqual(effects, [])
                    else:
                        result = runtime.run_operation(request)
                        self.assertEqual(effects, [0])
                        self.assertEqual(result["action"]["delivery"], "background")
                    self.assertEqual(restored, [True] if refused and restore else [])

    def test_restoration_requires_selected_window_focus_before_keyboard_input(self):
        restore_window = runtime.restore_window
        cases = (
            {"name": "native activation", "expected": True, "native": True},
            {"name": "unmanaged helper", "ids": "70\n71\n", "managed": [71], "expected": True, "native": True},
            {"name": "grab focus when no native window maps", "windows": 2, "ack": True, "expected": True},
            {"name": "two accessible windows", "windows": 2},
            {"name": "two native windows", "ids": "72\n71\n"},
            {"name": "failed managed window identity", "managed": [71, None]},
            {"name": "window on another workspace", "desktops": ("0", "2"), "error": "another workspace"},
            {"name": "unmapped window on another workspace", "windows": 2, "ack": True, "desktops": ("0", "2"), "error": "another workspace"},
            {"name": "window on every workspace", "desktops": ("0", "-1"), "expected": True, "native": True},
            {"name": "unreadable window workspace", "desktops": ("0", ""), "error": "another workspace"},
            {"name": "Wayland", "session": "wayland", "error": "unsupported capability"},
            {"name": "search timeout", "timeout": "search"},
            {"name": "activation timeout", "timeout": "windowactivate"},
            {"name": "activation refused", "refused": True, "native": True},
        )
        for case in cases:
            with self.subTest(case=case["name"]), SnapshotFixture(FakeAccessible("frame", "Editor")) as fixture:
                active = [99]
                activations, keys = [], []
                if case.get("windows") == 2:
                    fixture.app.children.append(FakeAccessible("frame", "Sibling"))

                def state():
                    states = [FakeStateType.SHOWING]
                    if active[0] == 71:
                        states.append(FakeStateType.ACTIVE)
                    return FakeStateSet(*states)

                def sleep(seconds):
                    fixture.clock += seconds

                def grab():
                    if case.get("ack"):
                        active[0] = 71
                    return bool(case.get("ack"))

                def activate(window_id):
                    activations.append(window_id)
                    if not case.get("refused"):
                        active[0] = window_id

                def native(command, **_kwargs):
                    stage = command[1]
                    if stage in {"get_desktop", "get_desktop_for_window"}:
                        current, target = case.get("desktops", ("0", "0"))
                        return types.SimpleNamespace(returncode=0, stdout=current if stage == "get_desktop" else target)
                    if case.get("timeout") == stage or (case.get("timeout") == "windowactivate" and "windowactivate" in command):
                        raise runtime.subprocess.TimeoutExpired(command, 2)
                    if stage == "search":
                        ids = case.get("ids", "71\n")
                        if "windowactivate" in command:
                            activate(int(ids.split()[0]))
                        return types.SimpleNamespace(returncode=0, stdout=ids)
                    if stage == "windowactivate":
                        activate(int(command[-1]))
                        return types.SimpleNamespace(returncode=int(bool(case.get("refused"))), stdout="")
                    if stage == "type":
                        keys.append(active[0])
                        return types.SimpleNamespace(returncode=0)
                    raise AssertionError("unexpected native operation")

                fixture.root.get_state_set = state
                with patch.object(runtime, "restore_window", restore_window), \
                     patch.object(runtime.time, "sleep", sleep), \
                     patch.object(runtime.Atspi.Component, "grab_focus", lambda _: grab(), create=True), \
                     patch.object(runtime.Atspi, "KeySynthType", types.SimpleNamespace(STRING=1), create=True), \
                     patch.object(runtime.Atspi, "generate_keyboard_event", lambda *_: keys.append(active[0]), create=True), \
                     patch.object(runtime.Gdk, "Screen", types.SimpleNamespace(get_default=lambda: types.SimpleNamespace(
                         get_window_stack=lambda: case.get("managed", [71, 72]))), create=True), \
                     patch.object(runtime, "GdkX11", types.SimpleNamespace(X11Window=types.SimpleNamespace(get_xid=int)), create=True), \
                     patch.object(runtime.shutil, "which", lambda _: "/usr/bin/xdotool"), \
                     patch.object(runtime, "temporary_x11_keymap", lambda *_: nullcontext(None)), \
                     patch.object(runtime.subprocess, "run", native), \
                     patch.dict(runtime.os.environ, {"XDG_SESSION_TYPE": case.get("session", "x11")}):
                    request = {"tool": "press_key", "key": "x", "app": "Fixture", "windowIndex": 0,
                               "restoreWindow": True, "noScreenshot": True}
                    if case.get("expected"):
                        self.assertTrue(runtime.run_operation(request)["ok"])
                    else:
                        with self.assertRaisesRegex(RuntimeError, case.get("error", "window_not_focused")):
                            runtime.run_operation(request)
                self.assertEqual(keys, [71] if case.get("expected") else [])
                self.assertEqual(activations, [71] if case.get("native") else [])
                if not case.get("expected"):
                    self.assertEqual(active[0], 99)

    def test_typing_stops_when_the_window_loses_focus_or_a_key_is_held(self):
        text = "a" * 100
        cases = (
            {"name": "idle", "typed": [40, 40, 20]},
            {"name": "caps lock", "masks": [0x2], "typed": [40, 40, 20], "clear": True},
            {"name": "focus lost", "inactive_after": 1, "typed": [40], "error": "lost focus after 40 of 100"},
            {"name": "held before", "masks": [0x4], "typed": [], "error": "modifier key"},
            {"name": "held during", "masks": [0, 0x1], "typed": [40], "error": "pressed after 40 of 100"},
        )
        for case in cases:
            with self.subTest(case=case["name"]):
                chunks, commands = [], []
                window = FakeAccessible("frame", "Editor")
                window.get_state_set = lambda: FakeStateSet(
                    *([] if len(chunks) >= case.get("inactive_after", 99) else [FakeStateType.ACTIVE]))
                masks = list(case.get("masks", [0]))
                def pointer():
                    return (0, 0, masks.pop(0) if len(masks) > 1 else masks[0])
                def run(command, input=None, **_):
                    commands.append(command)
                    chunks.append(len(input))
                exits = []
                @contextmanager
                def keymap(*_):
                    # Why: an exception exit releases newly held keys, which would release the user's modifier.
                    try:
                        yield None
                        exits.append("clean")
                    except BaseException:
                        exits.append("exception")
                        raise
                with patch.object(runtime, "x11_pointer_state", pointer), \
                     patch.object(runtime.Atspi, "set_timeout", lambda *_: None, create=True), \
                     patch.object(runtime.shutil, "which", lambda _: "/usr/bin/xdotool"), \
                     patch.object(runtime, "temporary_x11_keymap", keymap), \
                     patch.object(runtime.subprocess, "run", run):
                    if "error" in case:
                        with self.assertRaisesRegex(RuntimeError, case["error"]):
                            runtime.type_text(text, window)
                    else:
                        runtime.type_text(text, window)
                self.assertEqual(chunks, case["typed"])
                self.assertEqual(exits, ["clean"])
                self.assertEqual(any("--clearmodifiers" in command for command in commands), bool(case.get("clear")))

    def test_interrupted_pointer_input_releases_the_button_before_the_pointer_is_put_back(self):
        for name, send in (("drag", lambda: runtime.drag_between((10, 10), (50, 50))),
                           ("click", lambda: runtime.click_at(10, 10, "left", 1))):
            events = []
            def sleep(_):
                raise SystemExit(143)
            with self.subTest(tool=name), \
                 patch.object(runtime, "x11_pointer_state", lambda: (700, 800, 0)), \
                 patch.object(runtime.time, "sleep", sleep), \
                 patch.object(runtime.Atspi, "generate_mouse_event", lambda *args: events.append(args[2]), create=True):
                with self.assertRaises(SystemExit), runtime.pointer_put_back():
                    send()
            self.assertEqual(events[-2:], ["b1r", "abs"])
            self.assertEqual(events.count("b1p"), 1)

    def test_return_in_a_background_gtk_entry_activates_it_without_keys(self):
        for toolkit, multi_line, activates_window in (("gtk", False, False), ("gtk", False, True), ("Qt", False, False), ("gtk", True, False)):
            entry = FakeAccessible("text", "Search", value="cats")
            effects = []
            states = [FakeStateType.FOCUSED, FakeStateType.EDITABLE] + ([FakeStateType.MULTI_LINE] if multi_line else [])
            entry.get_state_set = lambda states=states: FakeStateSet(*states)
            entry.get_n_actions = lambda: 1
            entry.get_action_name = lambda _: "activate"
            entry.do_action = lambda index: effects.append(index) or True
            with self.subTest(toolkit=toolkit, multi_line=multi_line, activates_window=activates_window), \
                 SnapshotFixture(FakeAccessible("frame", "Editor", children=[entry])) as fixture, \
                 patch.object(runtime, "press_key") as keys:
                fixture.app.get_toolkit_name = lambda toolkit=toolkit: toolkit
                fixture.app.get_toolkit_version = lambda: "3.24"
                fixture.root.get_state_set = lambda: FakeStateSet(*([FakeStateType.ACTIVE] if effects and activates_window else []))
                request = {"tool": "press_key", "key": "Enter", "app": "Fixture", "noScreenshot": True}
                if toolkit == "gtk" and not multi_line:
                    result = runtime.run_operation(request)
                    self.assertEqual(effects, [0])
                    self.assertEqual(result["action"]["actionName"], "activate")
                    self.assertEqual(result["action"]["delivery"], "foreground" if activates_window else "background")
                else:
                    with self.assertRaisesRegex(RuntimeError, "background_unavailable.*type-text --element-index"):
                        runtime.run_operation(request)
                    self.assertEqual(effects, [])
                keys.assert_not_called()

    def test_gtk4_rectangles_come_from_window_extents_and_the_x11_client_origin(self):
        button = FakeAccessible("push button", "Open")
        window = FakeAccessible("frame", "Files", children=[button])
        app = FakeAccessible("application", "Files", children=[window])
        app.get_toolkit_name, app.get_toolkit_version = (lambda: "GTK"), (lambda: "4.14.5")
        # Why these numbers: GTK 4 answers SCREEN with [0, 0, w, h] (agent-desktop FINDINGS L23-37).
        extents = {(window, 0): (0, 0, 800, 600), (window, 1): (0, 0, 800, 600),
                   (button, 0): (0, 0, 64, 44), (button, 1): (16, 299, 64, 44)}
        for node in (window, button):
            node.get_component_iface = lambda node=node: node
        def get_extents(node, coord_type):
            x, y, width, height = extents[(node, coord_type)]
            return types.SimpleNamespace(x=x, y=y, width=width, height=height)
        for origin, wayland in (((1000, 500), False), (None, False), (None, True)):
            with self.subTest(origin=origin, wayland=wayland), \
                 patch.object(runtime.Atspi, "Component", types.SimpleNamespace(get_extents=get_extents), create=True), \
                 patch.object(runtime.Atspi, "CoordType", types.SimpleNamespace(SCREEN=0, WINDOW=1), create=True), \
                 patch.object(runtime, "gtk4_client_origin", lambda *_: origin), \
                 patch.object(runtime, "wayland_session", lambda: wayland):
                placed = runtime.Placement(app, window)
                self.assertEqual(placed.frame(button).to_json(), {"x": 16, "y": 299, "width": 64, "height": 44})
                if origin:
                    self.assertEqual(runtime.window_point(placed, {"index": 1}, node=button), (1048, 821))
                else:
                    with self.assertRaisesRegex(RuntimeError, "GTK 4 window"):
                        runtime.window_point(placed, {"index": 1}, node=button)

    def test_background_scroll_pages_a_scroll_bar_and_hands_the_end_to_the_outer_view(self):
        def view(name, value, high, children=()):
            bar = FakeAccessible("scroll bar", name + " bar")
            bar.position = value
            bar.high = high
            bar.get_state_set = lambda: FakeStateSet(FakeStateType.VERTICAL)
            bar.get_value_iface = lambda: bar
            pane = FakeAccessible("scroll pane", name, children=[bar, *children])
            return pane, bar
        row = FakeAccessible("list item", "Row")
        inner, inner_bar = view("inner", 300, 300, [row])
        outer, outer_bar = view("outer", 0, 2000, [inner])
        writes = []
        def set_value(bar, value):
            writes.append((bar.name, value))
            bar.position = value
            return True
        value_api = types.SimpleNamespace(get_minimum_value=lambda bar: 0, get_maximum_value=lambda bar: bar.high,
                                          get_current_value=lambda bar: bar.position, set_current_value=set_value)
        with SnapshotFixture(FakeAccessible("frame", "Editor", children=[outer])) as fixture, \
             patch.object(runtime.Atspi, "Value", value_api, create=True):
            fixture.bounds[outer] = runtime.Rect(100, 200, 300, 250)
            element = next(item for item in runtime.make_snapshot("Fixture", False)["elements"] if item["name"] == "Row")
            result = runtime.run_operation({"tool": "scroll", "app": "Fixture", "element": element, "direction": "down",
                                            "pages": 2, "noScreenshot": True})
            self.assertEqual(writes, [("outer bar", 500)])
            self.assertEqual(result["action"]["verification"], {"state": "verified", "property": "value"})
            self.assertEqual(result["action"]["delivery"], "background")
            runtime.run_operation({"tool": "scroll", "app": "Fixture", "element": element, "direction": "up",
                                   "pages": 0.5, "noScreenshot": True})
            self.assertEqual(writes[-1], ("inner bar", 300 - 0.5 * fixture.bounds[inner].height))

    def test_background_scroll_pages_a_document_with_scroll_to(self):
        items = [FakeAccessible("paragraph", f"Item {index}") for index in range(6)]
        document = FakeAccessible("document web", "Page", children=items)
        scrolled = []
        offset = [0]
        with SnapshotFixture(FakeAccessible("frame", "Browser", children=[document])) as fixture:
            fixture.bounds[document] = runtime.Rect(0, 100, 400, 300)
            def place():
                for index, item in enumerate(items):
                    fixture.bounds[item] = runtime.Rect(0, 100 + index * 120 - offset[0], 400, 120)
            place()
            def scroll_to(item, edge):
                scrolled.append((item.name, edge))
                offset[0] += fixture.bounds[item].y - 100
                place()
                return True
            with patch.object(runtime.Atspi.Component, "scroll_to", scroll_to, create=True), \
                 patch.object(runtime.Atspi, "ScrollType", types.SimpleNamespace(TOP_EDGE="top", BOTTOM_EDGE="bottom"), create=True):
                result = runtime.run_operation({"tool": "scroll", "app": "Fixture", "x": 50, "y": 50,
                                                "direction": "down", "pages": 3, "noScreenshot": True})
        # Why Item 2: it spans 340-460 and the viewport ends at 400, so its hidden half leads the next page.
        # The third page finds nothing past the document's end, and the two pages already moved still count.
        self.assertEqual(scrolled, [("Item 2", "top"), ("Item 4", "top")])
        self.assertEqual(result["action"]["actionName"], "scrollTo")

    def test_click_without_an_action_selects_the_row_only_when_its_index_is_proven(self):
        cases = (
            ("Qt", "6.6", None, "selected"),
            ("GTK", "4.14", (True, False), "selected"),
            ("GTK", "4.14", (True, True), "refused"),
            ("GTK", "4.14", (True, "timeout"), "refused"),
            ("Qt", "6.6", "replaced", "stale"),
            ("GTK", "3.24", "multiple", "selected"),
        )
        for toolkit, version, counted, expected in cases:
            rows = [FakeAccessible("list item", name) for name in ("Mouse", "Keyboard")]
            listing = FakeAccessible("list", "Devices", children=rows)
            selected = ["Mouse"] if counted == "multiple" else []
            listing.get_state_set = lambda: FakeStateSet(*([FakeStateType.MULTISELECTABLE] if counted == "multiple" else []))
            listing.get_selection_iface = lambda: listing
            if counted == "replaced":
                rows[1].get_index_in_parent = lambda: 0
            for row in rows:
                row.get_state_set = lambda row=row: FakeStateSet(*([FakeStateType.SELECTED] if row.name in selected else []))
            def is_child_selected(_, index):
                answer = (counted if isinstance(counted, tuple) else (True, False))[index - len(rows) + 1]
                if answer is not True:
                    raise RuntimeError("Timeout was reached" if answer == "timeout" else "GDBus.Error:org.freedesktop.DBus.Error.InvalidArgs")
                return False
            selection = types.SimpleNamespace(
                select_child=lambda _, index: selected.append(rows[index].name) or True,
                clear_selection=lambda _: selected.clear() or True,
                is_child_selected=is_child_selected)
            with self.subTest(toolkit=toolkit, counted=counted), \
                 SnapshotFixture(FakeAccessible("frame", "Settings", children=[listing])) as fixture, \
                 patch.object(runtime.Atspi, "Selection", selection, create=True), \
                 patch.object(runtime, "gtk4_client_origin", lambda *_: (0, 0)):
                fixture.app.get_toolkit_name, fixture.app.get_toolkit_version = (lambda: toolkit), (lambda: version)
                element = next(item for item in runtime.make_snapshot("Fixture", False)["elements"] if item["name"] == "Keyboard")
                request = {"tool": "click", "app": "Fixture", "element": element, "noScreenshot": True}
                if expected == "selected":
                    result = runtime.run_operation(request)
                    self.assertEqual(selected, ["Keyboard"])
                    self.assertEqual(result["action"]["verification"], {"state": "verified", "property": "selection"})
                else:
                    with self.assertRaisesRegex(RuntimeError, "background_unavailable" if expected == "refused" else "stale element"):
                        runtime.run_operation(request)
                    self.assertEqual(selected, [])

    def test_text_entry_inserts_into_the_focused_field_of_a_background_window(self):
        cases = (
            ("type_text", "🚀 café", (6, 11), "Hello 🚀 café", 12),
            ("paste_text", "there", None, "Hello worldthere", 16),
        )
        for tool, value, selection, expected, expected_caret in cases:
            field = FakeAccessible("text", "Message", value="Hello world")
            field.caret, field.selection = 11, selection
            field.get_state_set = lambda: FakeStateSet(FakeStateType.FOCUSED, FakeStateType.EDITABLE)
            field.get_editable_text_iface = lambda: field
            with self.subTest(tool=tool, value=value, selection=selection), SnapshotFixture(FakeAccessible("frame", "Editor", children=[field])) as fixture:
                calls = []
                fixture.restore = lambda: calls.append("restore")
                with patch.object(runtime, "type_text", lambda _: calls.append("keys")), \
                     patch.object(runtime, "paste_text", lambda _: calls.append("clipboard")):
                    result = runtime.run_operation({"tool": tool, "app": "Fixture", "text": value, "noScreenshot": True})
                self.assertEqual(calls, [])
                self.assertEqual((field.value, field.caret), (expected, expected_caret))
                self.assertEqual(result["action"]["path"], "accessibility")
                self.assertEqual(result["action"]["verification"]["state"], "verified")

    def test_element_text_entry_targets_the_named_field_and_never_types_at_focus(self):
        for editable in (True, False):
            focused = FakeAccessible("text", "Search", value="")
            focused.caret, focused.selection = 0, None
            focused.get_state_set = lambda: FakeStateSet(FakeStateType.FOCUSED, FakeStateType.EDITABLE)
            focused.get_editable_text_iface = lambda: focused
            target = FakeAccessible("text", "Message", value="Hello ")
            target.caret, target.selection = 6, None
            target.get_state_set = (lambda: FakeStateSet(FakeStateType.EDITABLE)) if editable else (lambda: FakeStateSet())
            target.get_editable_text_iface = lambda: target
            with self.subTest(editable=editable), SnapshotFixture(FakeAccessible("frame", "Editor", children=[focused, target])) as fixture, \
                 patch.object(runtime, "type_text") as keys:
                fixture.root.get_state_set = lambda: FakeStateSet(FakeStateType.ACTIVE)
                element = next(item for item in runtime.make_snapshot("Fixture", False)["elements"] if item["name"] == "Message")
                request = {"tool": "type_text", "app": "Fixture", "element": element, "text": "🚀 café", "noScreenshot": True}
                if editable:
                    result = runtime.run_operation(request)
                    self.assertEqual(target.value, "Hello 🚀 café")
                    self.assertEqual(result["action"]["verification"], {"state": "verified", "property": "elementText"})
                else:
                    with self.assertRaisesRegex(RuntimeError, "not settable"):
                        runtime.run_operation(request)
                    self.assertEqual(target.value, "Hello ")
                self.assertEqual(focused.value, "")
                keys.assert_not_called()

    def test_text_entry_without_an_editable_focused_field_still_requires_window_focus(self):
        cases = (
            ("type_text", False, "not-editable", 1, (6, 11)),
            ("type_text", True, "not-editable", 1, (6, 11)),
            ("paste_text", False, "not-editable", 1, (6, 11)),
            ("paste_text", True, "not-editable", 1, (6, 11)),
            ("type_text", False, "multiple", 2, (6, 11)),
            ("type_text", False, "range-outside", 1, (6, 12)),
        )
        for tool, active, name, count, selection in cases:
            field = FakeAccessible("text", "Message", value="Hello world")
            field.caret, field.selection = 11, (6, 11)
            states = [FakeStateType.FOCUSED] + ([] if name == "not-editable" else [FakeStateType.EDITABLE])
            field.get_state_set = lambda: FakeStateSet(*states)
            field.get_editable_text_iface = lambda: field
            selected = types.SimpleNamespace(start_offset=selection[0], end_offset=selection[1])
            with self.subTest(tool=tool, active=active, case=name), SnapshotFixture(
                FakeAccessible("frame", "Editor", children=[field])
            ) as fixture, patch.object(runtime.Atspi.Text, "get_n_selections", return_value=count), \
                 patch.object(runtime.Atspi.Text, "get_selection", return_value=selected), \
                 patch.object(runtime.Atspi.EditableText, "insert_text", wraps=FakeEditableText.insert_text) as insert, \
                 patch.object(runtime, "type_text") as keys, patch.object(runtime, "paste_text") as paste:
                if active:
                    fixture.root.get_state_set = lambda: FakeStateSet(FakeStateType.ACTIVE)
                    result = runtime.run_operation({"tool": tool, "app": "Fixture", "text": "x", "noScreenshot": True})
                    if tool == "type_text":
                        keys.assert_called_once_with("x", fixture.root)
                    else:
                        paste.assert_called_once_with("x")
                    self.assertEqual(result["action"]["verification"]["state"], "unverified")
                else:
                    with self.assertRaisesRegex(RuntimeError, "background_unavailable"):
                        runtime.run_operation({"tool": tool, "app": "Fixture", "text": "x", "noScreenshot": True})
                if not active or tool != "type_text":
                    keys.assert_not_called()
                if not active or tool != "paste_text":
                    paste.assert_not_called()
                insert.assert_not_called()
                self.assertEqual((field.value, field.selection), ("Hello world", (6, 11)))

    def test_partial_text_replacement_fails_without_typing_again(self):
        tool = "type_text"
        for failure in (
            True,
            TimeoutError("provider timed out"),
            "wrong-range",
        ):
            field = FakeAccessible("text", "Message", value="Hello world")
            field.caret, field.selection = 11, (6, 11)
            field.get_state_set = lambda: FakeStateSet(FakeStateType.FOCUSED, FakeStateType.EDITABLE)
            field.get_editable_text_iface = lambda: field
            def delete(node, _start, _end):
                if failure == "wrong-range":
                    node.value = node.value[5:]
                    node.selection = None
                    return True
                if isinstance(failure, Exception):
                    raise failure
                return failure
            with self.subTest(tool=tool, failure=failure), SnapshotFixture(
                FakeAccessible("frame", "Editor", children=[field])
            ) as fixture, patch.object(runtime.Atspi.EditableText, "delete_text", delete), \
                 patch.object(runtime, "type_text") as keys, patch.object(runtime, "paste_text") as paste:
                fixture.root.get_state_set = lambda: FakeStateSet(FakeStateType.ACTIVE)
                with self.assertRaisesRegex(RuntimeError, "text_replacement_incomplete"):
                    runtime.run_operation({"tool": tool, "app": "Fixture", "text": "there", "noScreenshot": True})
                self.assertEqual(field.value, " worldthere" if failure == "wrong-range" else "Hello worldthere")
                keys.assert_not_called()
                paste.assert_not_called()

    def test_unconfirmed_text_insertion_does_not_fall_back_to_another_write(self):
        write = FakeEditableText.insert_text
        failures = {
            "timeout-after-write": "foobarbar",
            "no-op": "foobar",
            "wrong-text": "foobazbar",
        }
        tool = "type_text"
        for failure, expected in failures.items():
            field = FakeAccessible("text", "Message", value="foobar")
            field.caret, field.selection = 6, (0, 3)
            field.get_state_set = lambda: FakeStateSet(FakeStateType.FOCUSED, FakeStateType.EDITABLE)
            field.get_editable_text_iface = lambda: field
            def insert(node, position, text, length):
                if failure == "no-op":
                    return True
                write(node, position, "baz" if failure == "wrong-text" else text, length)
                if failure == "timeout-after-write":
                    raise TimeoutError("reply lost after insertion")
                return True
            with self.subTest(tool=tool, failure=failure), SnapshotFixture(
                FakeAccessible("frame", "Editor", children=[field])
            ) as fixture, patch.object(runtime.Atspi.EditableText, "insert_text", side_effect=insert), \
                 patch.object(runtime, "type_text") as keys, patch.object(runtime, "paste_text") as paste:
                fixture.root.get_state_set = lambda: FakeStateSet(FakeStateType.ACTIVE)
                with self.assertRaisesRegex(RuntimeError, "text_insertion_unconfirmed"):
                    runtime.run_operation({"tool": tool, "app": "Fixture", "text": "bar", "noScreenshot": True})
                self.assertEqual(field.value, expected)
                self.assertEqual(field.selection, (0, 3))
                keys.assert_not_called()
                paste.assert_not_called()

    def test_unconfirmed_caret_movement_does_not_report_text_entry_success(self):
        tool = "type_text"
        field = FakeAccessible("text", "Message", value="Hello world")
        field.caret, field.selection = 6, (6, 11)
        field.get_state_set = lambda: FakeStateSet(FakeStateType.FOCUSED, FakeStateType.EDITABLE)
        field.get_editable_text_iface = lambda: field
        with SnapshotFixture(
            FakeAccessible("frame", "Editor", children=[field])
        ) as fixture, patch.object(runtime.Atspi.Text, "set_caret_offset", return_value=True), \
             patch.object(runtime, "type_text") as keys, patch.object(runtime, "paste_text") as paste:
            fixture.root.get_state_set = lambda: FakeStateSet(FakeStateType.ACTIVE)
            with self.assertRaisesRegex(RuntimeError, "text_caret_unconfirmed"):
                runtime.run_operation({"tool": tool, "app": "Fixture", "text": "there", "noScreenshot": True})
            self.assertEqual((field.value, field.caret), ("Hello there", 6))
            keys.assert_not_called()
            paste.assert_not_called()

    def test_compacted_browser_records_keep_their_own_frames_and_indexes(self):
        tabs = [FakeAccessible("page tab", f"Tab {i}", value="1" if i == 9 else "") for i in range(10)]
        buttons = [FakeAccessible("button", f"Other {i}") for i in range(10)]
        root = FakeAccessible("frame", "Browser", children=[
            FakeAccessible("page tab list", "Tabs", children=tabs), *buttons,
        ])
        with SnapshotFixture(root, "chrome") as fixture:
            fixture.delays = {tab: 20 for tab in tabs[:-1]}
            snapshot = runtime.make_snapshot("chrome", False)
            by_name = {item["name"]: item for item in snapshot["elements"]}
            for node, expected_x in ((tabs[-1], 110), (buttons[8], 200)):
                self.assertEqual(by_name[node.name]["frame"]["x"], expected_x)
            indexes = [item["index"] for item in snapshot["elements"]]
            self.assertEqual(len(indexes), len(set(indexes)))

    def test_root_reads_a_subtree_beyond_the_full_snapshot_limit(self):
        items = [FakeAccessible("button", f"A{i}") for i in range(3)]
        root = FakeAccessible("frame", "Main", children=[
            FakeAccessible("list", "Items", children=items), FakeAccessible("button", "After"),
        ])
        with SnapshotFixture(root), patch.object(runtime, "MAX_NODES", 4):
            snapshot = runtime.make_snapshot("Fixture", False)
            items_record = next(item for item in snapshot["elements"] if item["name"] == "Items")
            subtree = runtime.run_operation({"tool": "get_app_state", "app": "Fixture", "noScreenshot": True, "root": items_record})["snapshot"]
            self.assertEqual(subtree["elements"][-1]["runtimeId"], [0, 0, 2])


if __name__ == "__main__":
    unittest.main()

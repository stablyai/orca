from contextlib import ExitStack, nullcontext
import importlib.util
import json
import sys
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
            (runtime.Atspi, "CoordType", types.SimpleNamespace(SCREEN=0)),
            (runtime, "capture_png", self.capture),
            (runtime, "restore_window", lambda *_: self.restore()),
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

    def test_grim_captures_the_compositor_window_at_logical_scale(self):
        pixbuf = types.SimpleNamespace(get_width=lambda: 640, get_height=lambda: 480)
        loader = types.SimpleNamespace(write=lambda _: None, close=lambda: None, get_pixbuf=lambda: pixbuf)
        with patch.object(runtime.GdkPixbuf, "PixbufLoader", types.SimpleNamespace(new_with_type=lambda _: loader), create=True), \
             patch.object(runtime, "png_bytes", return_value=b"png"):
            result = runtime.capture_png(runtime.Rect(0, 0, 640, 480), self.app, self.window)
        self.assertEqual(self.commands[-1], ["/usr/bin/grim", "-s", "1", "-g", "-800,40 640x480", "-t", "png", "-"])
        self.assertEqual(result, {"base64": "cG5n", "width": 640, "height": 480, "scale": 1.0})

    def test_ambiguous_missing_and_hidden_windows_never_capture_another_region(self):
        for clients in ([], self.clients * 2, [{**self.clients[0], "hidden": True}],
                        [{**self.clients[0], "workspace": {"id": 3}}],
                        [{**self.clients[0], "size": [700, 480]}],
                        [{**self.clients[0], "pid": 43}], [{**self.clients[0], "size": [0, 480]}]):
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
            self.assertEqual(command, ["/usr/bin/swaymsg", "-t", "get_tree", "-r"])
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

    def test_grim_failure_and_timeout_preserve_accessibility_only_results(self):
        native = self.run_native
        for failure in (1, runtime.subprocess.TimeoutExpired("grim", 5)):
            def failed(command, **options):
                if not command[0].endswith("grim"):
                    return native(command, **options)
                if isinstance(failure, Exception):
                    raise failure
                return types.SimpleNamespace(returncode=failure)
            with self.subTest(failure=failure), patch.object(runtime.subprocess, "run", side_effect=failed):
                result = runtime.capture_png(runtime.Rect(0, 0, 640, 480), self.app, self.window)
                self.assertEqual(result["error"]["code"], "screenshot_failed")

    def test_x11_retains_gdk_capture_without_running_grim(self):
        root = object()
        screen = types.SimpleNamespace(get_root_window=lambda: root)
        pixbuf = types.SimpleNamespace(get_width=lambda: 640, get_height=lambda: 480)
        with patch.dict(runtime.os.environ, {"XDG_SESSION_TYPE": "x11", "HYPRLAND_INSTANCE_SIGNATURE": ""}), \
             patch.object(runtime.Gdk, "Screen", types.SimpleNamespace(get_default=lambda: screen), create=True), \
             patch.object(runtime.Gdk, "pixbuf_get_from_window", return_value=pixbuf, create=True) as capture, \
             patch.object(runtime, "png_bytes", return_value=b"png"):
            result = runtime.capture_png(runtime.Rect(100, 50, 640, 480))
        capture.assert_called_once_with(root, 100, 50, 640, 480)
        self.assertEqual(result, {"base64": "cG5n", "width": 640, "height": 480, "scale": 1.0})
        self.assertEqual(self.commands, [])

    def test_capabilities_require_grim_and_a_supported_compositor(self):
        with patch.object(runtime.shutil, "which", side_effect=lambda name: None if name == "grim" else "/usr/bin/" + name):
            self.assertFalse(runtime.handshake_response()["supports"]["observation"]["screenshot"])
        with patch.dict(runtime.os.environ, {"HYPRLAND_INSTANCE_SIGNATURE": "", "SWAYSOCK": ""}):
            self.assertFalse(runtime.handshake_response()["supports"]["observation"]["screenshot"])
        self.assertTrue(runtime.handshake_response()["supports"]["observation"]["screenshot"])


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


    def test_pointer_input_waits_for_activation_and_uses_restored_geometry(self):
        operations = (
            {"tool": "click", "x": 5, "y": 6},
            {"tool": "scroll", "x": 5, "y": 6, "direction": "down", "pages": 1},
            {"tool": "drag", "from_x": 5, "from_y": 6, "to_x": 25, "to_y": 26},
        )
        for operation in operations:
            for activates in (False, True):
                with self.subTest(tool=operation["tool"], activates=activates), SnapshotFixture(
                    FakeAccessible("frame", "Editor")
                ) as fixture:
                    restored = []
                    pointer_calls = []
                    fixture.root.get_state_set = lambda: FakeStateSet(
                        *([FakeStateType.ACTIVE] if activates and restored and fixture.clock >= 0.1 else [])
                    )
                    def restore():
                        restored.append(True)
                        fixture.bounds[fixture.root] = runtime.Rect(500, 200, 300, 400)
                    fixture.restore = restore
                    def sleep(seconds):
                        fixture.clock += seconds
                    with patch.object(runtime.time, "sleep", sleep), \
                         patch.object(runtime, "click_at", lambda *args: pointer_calls.append(args[:2])), \
                         patch.object(runtime, "scroll_at", lambda *args: pointer_calls.append(args[:2])), \
                         patch.object(runtime, "drag_between", lambda start, end: pointer_calls.extend((start, end))):
                        request = {**operation, "app": "Fixture", "noScreenshot": True, "restoreWindow": False}
                        if activates:
                            result = runtime.run_operation(request)
                            self.assertTrue(result["ok"])
                            self.assertEqual(pointer_calls, [(505, 206), (525, 226)] if operation["tool"] == "drag" else [(505, 206)])
                            self.assertGreaterEqual(fixture.clock, 0.1)
                        else:
                            with self.assertRaisesRegex(RuntimeError, "window_not_focused"):
                                runtime.run_operation(request)
                            self.assertEqual(pointer_calls, [])
                            self.assertGreaterEqual(fixture.clock, 0.5)
                    self.assertTrue(restored)

    def test_restoration_requires_selected_window_focus_before_keyboard_input(self):
        restore_window = runtime.restore_window
        cases = (
            {"name": "already active", "initial": 71, "expected": True, "native": False},
            {"name": "delayed AT-SPI focus", "ack": False, "delay": 0.1, "expected": True, "native": False},
            {"name": "ineffective true acknowledgment", "ack": True, "expected": True, "native": True},
            {"name": "unmanaged helper", "ids": "70\n71\n", "managed": [71], "expected": True, "native": True},
            {"name": "two accessible windows", "windows": 2},
            {"name": "two native windows", "ids": "72\n71\n"},
            {"name": "missing managed stack", "managed": None},
            {"name": "failed managed window identity", "managed": [71, None]},
            {"name": "invalid managed window identity", "managed": [71, 0]},
            {"name": "Wayland", "session": "wayland"},
            {"name": "search timeout", "timeout": "search"},
            {"name": "activation timeout", "timeout": "windowactivate"},
            {"name": "activation refused", "refused": True},
        )
        for case in cases:
            with self.subTest(case=case["name"]), SnapshotFixture(FakeAccessible("frame", "Editor")) as fixture:
                active = [case.get("initial", 99)]
                activations, keys = [], []
                if case.get("windows") == 2:
                    fixture.app.children.append(FakeAccessible("frame", "Sibling"))

                def state():
                    if fixture.clock >= case.get("delay", float("inf")):
                        active[0] = 71
                    states = [FakeStateType.SHOWING]
                    if active[0] == 71:
                        states.append(FakeStateType.ACTIVE)
                    return FakeStateSet(*states)

                def sleep(seconds):
                    fixture.clock += seconds

                def activate(window_id):
                    activations.append(window_id)
                    if not case.get("refused"):
                        active[0] = window_id

                def native(command, **_kwargs):
                    stage = command[1]
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
                     patch.object(runtime.Atspi.Component, "grab_focus", lambda _: case.get("ack", False), create=True), \
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
                        with self.assertRaisesRegex(RuntimeError, "window_not_focused"):
                            runtime.run_operation(request)
                self.assertEqual(keys, [71] if case.get("expected") else [])
                self.assertEqual(activations, [71] if case.get("native") or case.get("refused") else [])
                if not case.get("expected"):
                    self.assertEqual(active[0], 99)

    def test_text_entry_inserts_into_the_focused_field_of_a_background_window(self):
        for tool in ("type_text", "paste_text"):
            for value in ("there", "🚀 café"):
                for selection in ((6, 11), None):
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
                        prefix = "Hello " if selection else "Hello world"
                        self.assertEqual((field.value, field.caret), (prefix + value, len(prefix) + len(value)))
                        self.assertEqual(result["action"]["path"], "accessibility")
                        self.assertEqual(result["action"]["verification"]["state"], "verified")

    def test_text_entry_without_an_editable_focused_field_still_requires_window_focus(self):
        cases = [
            ("not-editable", 1, (6, 11)),
            ("count-error", TimeoutError("selection timed out"), (6, 11)),
            ("multiple", 2, (6, 11)),
            ("range-error", 1, TimeoutError("range timed out")),
            ("range-outside", 1, (6, 12)),
        ]
        for tool in ("type_text", "paste_text"):
            for active in (False, True):
                for name, count, selection in cases:
                    field = FakeAccessible("text", "Message", value="Hello world")
                    field.caret, field.selection = 11, (6, 11)
                    states = [FakeStateType.FOCUSED] + ([] if name == "not-editable" else [FakeStateType.EDITABLE])
                    field.get_state_set = lambda: FakeStateSet(*states)
                    field.get_editable_text_iface = lambda: field
                    selected = types.SimpleNamespace(start_offset=selection[0], end_offset=selection[1]) if isinstance(selection, tuple) else selection
                    with self.subTest(tool=tool, active=active, case=name), SnapshotFixture(
                        FakeAccessible("frame", "Editor", children=[field])
                    ) as fixture, patch.object(runtime.Atspi.Text, "get_n_selections", return_value=count, side_effect=count if isinstance(count, Exception) else None), \
                         patch.object(runtime.Atspi.Text, "get_selection", return_value=selected, side_effect=selected if isinstance(selected, Exception) else None), \
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
                            with self.assertRaisesRegex(RuntimeError, "window_not_focused"):
                                runtime.run_operation({"tool": tool, "app": "Fixture", "text": "x", "noScreenshot": True})
                        if not active or tool != "type_text":
                            keys.assert_not_called()
                        if not active or tool != "paste_text":
                            paste.assert_not_called()
                        insert.assert_not_called()
                        self.assertEqual((field.value, field.selection), ("Hello world", (6, 11)))

    def test_partial_text_replacement_fails_without_typing_again(self):
        tool = "type_text"
        for failure in (False, True, TimeoutError("provider timed out"), "wrong-range"):
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
            "false-after-write": "foobarbar",
            "timeout-after-write": "foobarbar",
            "no-op": "foobar",
            "truncated": "foobbar",
            "wrong-text": "foobazbar",
            "count-unavailable": "foobarbar",
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
                write(node, position, "baz" if failure == "wrong-text" else text, 1 if failure == "truncated" else length)
                if failure == "timeout-after-write":
                    raise TimeoutError("reply lost after insertion")
                return failure != "false-after-write"
            def count(node):
                return None if failure == "count-unavailable" and node.value != "foobar" else len(node.value)
            with self.subTest(tool=tool, failure=failure), SnapshotFixture(
                FakeAccessible("frame", "Editor", children=[field])
            ) as fixture, patch.object(runtime.Atspi.EditableText, "insert_text", side_effect=insert), \
                 patch.object(runtime.Atspi.Text, "get_character_count", side_effect=count), \
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
        for failure in (False, True, TimeoutError("provider timed out")):
            field = FakeAccessible("text", "Message", value="Hello world")
            field.caret, field.selection = 6, (6, 11)
            field.get_state_set = lambda: FakeStateSet(FakeStateType.FOCUSED, FakeStateType.EDITABLE)
            field.get_editable_text_iface = lambda: field
            with self.subTest(tool=tool, failure=failure), SnapshotFixture(
                FakeAccessible("frame", "Editor", children=[field])
            ) as fixture, patch.object(runtime.Atspi.Text, "set_caret_offset", side_effect=failure if isinstance(failure, Exception) else None, return_value=failure), \
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
            for node in (tabs[-1], buttons[8]):
                self.assertEqual(by_name[node.name]["frame"]["x"], fixture.bounds[node].x - 100)
            self.assertNotIn("Tab 0", by_name)
            indexes = [item["index"] for item in snapshot["elements"]]
            self.assertEqual(len(indexes), len(set(indexes)))















if __name__ == "__main__":
    unittest.main()

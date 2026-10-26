import ctypes
from contextlib import ExitStack
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


class FakeText:
    @staticmethod
    def get_character_count(node):
        return len(node.value)

    @staticmethod
    def get_text(node, start, end):
        return node.value[start:end]


def load_runtime():
    gi = types.ModuleType("gi")
    repository = types.ModuleType("gi.repository")
    gi.require_version = lambda *_: None
    repository.Atspi = types.SimpleNamespace(StateType=FakeStateType, Text=FakeText)
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
    # Why: the Desktop App tools must run without gi, so importing the module may not touch it.
    assert module.Atspi is None
    module.load_accessibility_bindings()
    return module


runtime = load_runtime()


class FakeAccessible:
    def __init__(self, role, name="", value="", children=(), counter=None):
        self.role = role
        self.name = name
        self.value = value
        self.children = list(children)
        self.counter = counter or {"child_reads": 0}
        for child in self.children:
            child.use_counter(self.counter)

    def use_counter(self, counter):
        self.counter = counter
        for child in self.children:
            child.use_counter(counter)

    def get_child_count(self):
        self.counter["child_reads"] += 1
        return len(self.children)

    def get_child_at_index(self, index):
        self.counter["child_reads"] += 1
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


class FailingChildrenAccessible(FakeAccessible):
    def get_child_count(self):
        self.counter["child_reads"] += 1
        raise RuntimeError("defunct node")


def render(root):
    return runtime.render_accessibility_tree(root, [0])


class SnapshotFixture(ExitStack):
    def __init__(self, root, app_name="Fixture"):
        super().__init__()
        self.root = root
        self.app = FakeAccessible("application", app_name, children=[root])
        self.app.get_process_id = lambda: 42
        self.clock = 0.0
        self.timeout = (800, 15000)
        self.delays = {}
        self.stalled = []
        self.captured_at = None
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
            self.stalled.append(node.name)
            raise TimeoutError("unresponsive geometry")
        return self.bounds.get(node)

    def capture(self, bounds):
        self.clock += 1
        self.captured_at = self.clock
        return {"base64": json.dumps(bounds.to_json())} if bounds else None


class RuntimeRenderTest(unittest.TestCase):
    def test_snapshot_keeps_semantics_and_image_when_child_geometry_stalls(self):
        late = FakeAccessible("button", "Continue")
        root = FakeAccessible("frame", "Editor", children=[
            FakeAccessible("button", "Healthy"),
            *[FakeAccessible("button", f"Slow {i}") for i in range(4)], late,
        ])
        for semantic_delay, stall_children in ((3.1, False), (16, True)):
            with self.subTest(semantic_delay=semantic_delay), SnapshotFixture(root) as fixture:
                late.read = False
                fixture.delays = {root: 1, **{node: 20 if stall_children else 0 for node in root.children[1:-1]}}
                def delayed_name():
                    if not getattr(late, "read", False):
                        fixture.clock += semantic_delay
                        late.read = True
                    return "" if fixture.stalled else "Continue"
                late.get_name = delayed_name
                late.get_n_actions = lambda: 1
                late.get_action_name = lambda _: "click"
                snapshot = runtime.make_snapshot("Fixture", True, window_index=0)
                self.assertLessEqual(fixture.clock - fixture.captured_at, 3)
                self.assertEqual(fixture.timeout, (800, 15000))
                elements = snapshot["elements"]
                self.assertEqual([item["name"] for item in elements], [root.name, *[n.name for n in root.children]])
                self.assertEqual([item["index"] for item in elements], list(range(7)))
                self.assertEqual(elements[-1]["runtimeId"], [0, 5])
                self.assertEqual(elements[-1]["actions"], ["click"])
                self.assertEqual(snapshot["treeLines"][-1], "\t6 button Continue")
                self.assertFalse(snapshot["truncation"]["truncated"])
                self.assertEqual(snapshot["windowBounds"], fixture.bounds[root].to_json())
                self.assertEqual(json.loads(snapshot["screenshotPngBase64"]), fixture.bounds[root].to_json())
                self.assertEqual(elements[0]["frame"], runtime.Rect(0, 0, 300, 400).to_json())
                self.assertEqual(elements[1]["frame"], runtime.Rect(10, 20, 300, 400).to_json())
                self.assertTrue(all((item["frame"] is None) == stall_children for item in elements[2:]))

    def test_nonstandard_window_selection_and_fresh_restored_capture(self):
        for query, index, delay, restore in (("Fixture", None, 1, False),
                                             ("pid:42", 1, 1, False), ("Editor", 1, 0, True)):
            with self.subTest(query=query), SnapshotFixture(
                FakeAccessible("panel", "Editor", children=[FakeAccessible("button", "Save")])
            ) as fixture:
                root = fixture.root
                fixture.app.children.insert(0, FakeAccessible("label", "Unrelated"))
                fixture.delays[root] = delay
                def move():
                    fixture.bounds[root] = runtime.Rect(500, 200, 300, 400)
                    fixture.bounds[root.children[0]] = runtime.Rect(510, 220, 300, 400)
                fixture.restore = move
                snapshot = runtime.make_snapshot(query, True, window_index=index, restore=restore)
                self.assertEqual(snapshot["windowIndex"], 1)
                self.assertEqual(snapshot["windowBounds"]["x"], 500 if restore else 100)
                self.assertEqual(snapshot["elements"][1]["frame"]["x"], 10)
                self.assertEqual(json.loads(snapshot["screenshotPngBase64"]), fixture.bounds[root].to_json())

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

    def test_compacted_browser_records_keep_their_own_frames(self):
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

    def test_geometry_skips_insufficient_budget_and_restores_action_timeout(self):
        clock = [0.0]
        timeouts = []

        def fail():
            raise TimeoutError("unresponsive geometry")

        with patch.object(runtime.time, "monotonic", side_effect=lambda: clock[0]), \
             patch.object(runtime.Atspi, "set_timeout", side_effect=lambda *args: timeouts.append(args), create=True):
            reader = runtime.GeometryReader()
            clock[0] = 2.96
            calls = []
            self.assertIsNone(reader.read(lambda: calls.append("called")))
            self.assertEqual(calls, [])
            self.assertEqual(timeouts, [])
            clock[0] = 2.9
            self.assertIsNone(reader.read(fail))
            self.assertGreaterEqual(timeouts[0][0], 50)
            self.assertLessEqual(timeouts[0][0], 100)
            self.assertEqual(timeouts[0][1], -1)
            self.assertEqual(timeouts[-1], (800, 15000))

    def test_named_non_generic_node_skips_unused_summary_walk(self):
        root = FakeAccessible("button", "Save", children=[FakeAccessible("text", "unused")])

        records, lines, truncation = render(root)

        self.assertEqual([record["name"] for record in records], ["Save"])
        self.assertEqual(lines, ["0 button Save"])
        self.assertEqual(root.counter["child_reads"], 0)
        self.assertFalse(truncation["truncated"])

    def test_wide_labeled_controls_never_enumerate_suppressed_children(self):
        roles = (
            "button", "check box", "checkbox", "combo box", "heading", "link",
            "menu item", "page tab", "push button", "radio button",
        )
        for role in roles:
            with self.subTest(role=role):
                root = FakeAccessible(
                    role, "Save", children=[FakeAccessible("text", str(i)) for i in range(10000)]
                )

                records, lines, truncation = render(root)

                self.assertEqual([item["runtimeId"] for item in records], [[0]])
                self.assertEqual(lines, [f"0 {role} Save"])
                self.assertEqual(root.counter["child_reads"], 0)
                self.assertFalse(truncation["truncated"])

    def test_control_value_or_identifier_keeps_suppression(self):
        value_node = FakeAccessible("combo box", value="Choice", children=[FakeAccessible("text", "Child")])
        identifier_node = FakeAccessible("button", children=[FakeAccessible("text", "Child")])
        identifier_node.get_accessible_id = lambda: "save-button"
        for root, expected in (
            (value_node, "0 combo box, Value: Choice"),
            (identifier_node, "0 button save-button"),
        ):
            with self.subTest(expected=expected):
                records, lines, truncation = render(root)

                self.assertEqual(len(records), 1)
                self.assertEqual(lines, [expected])
                self.assertEqual(root.counter["child_reads"], 0)
                self.assertFalse(truncation["truncated"])

    def test_unlabeled_controls_keep_child_indices_and_depth(self):
        root = FakeAccessible("button", children=[FakeAccessible("button", "Nested")])

        records, lines, truncation = render(root)

        self.assertEqual([item["runtimeId"] for item in records], [[0], [0, 0]])
        self.assertEqual(lines, ["0 button", "\t1 button Nested"])
        self.assertFalse(truncation["truncated"])

    def test_suppressed_child_failure_keeps_control_output(self):
        root = FailingChildrenAccessible("button", "Save")

        records, lines, truncation = render(root)

        self.assertEqual([item["name"] for item in records], ["Save"])
        self.assertEqual(lines, ["0 button Save"])
        self.assertFalse(truncation["truncated"])
        self.assertEqual(root.counter["child_reads"], 0)

    def test_named_generic_node_keeps_children_without_a_summary(self):
        root = FakeAccessible("section", "Details", children=[FakeAccessible("text", "body")])

        records, lines, _ = render(root)

        self.assertEqual([record["name"] for record in records], ["Details", "body"])
        self.assertEqual(lines, ["0 section Details", "\t1 text body"])

    def test_unnamed_generic_node_keeps_plain_text_summary(self):
        root = FakeAccessible(
            "section",
            children=[FakeAccessible("text", "Alpha"), FakeAccessible("text", "Beta")],
        )

        records, lines, _ = render(root)

        self.assertEqual(len(records), 1)
        self.assertEqual(lines, ["0 section, Text: Alpha Beta"])

    def test_row_keeps_its_specific_summary_walk(self):
        root = FakeAccessible(
            "row",
            "Invoice",
            children=[FakeAccessible("text", "Alpha"), FakeAccessible("text", "Beta")],
        )

        records, lines, _ = render(root)

        self.assertEqual([record["name"] for record in records], ["Invoice", "Alpha", "Beta"])
        self.assertEqual(lines, ["0 row Invoice, Text: Alpha Beta", "\t1 text Alpha", "\t2 text Beta"])

    def test_empty_generic_wrapper_keeps_elision_path_and_depth(self):
        root = FakeAccessible("section", children=[FakeAccessible("button", "Continue")])

        records, lines, _ = render(root)

        self.assertEqual([record["runtimeId"] for record in records], [[0, 0]])
        self.assertEqual(lines, ["0 button Continue"])

    def test_child_failure_keeps_fail_soft_row_output(self):
        root = FailingChildrenAccessible("row", "Invoice")

        records, lines, truncation = render(root)

        self.assertEqual([record["name"] for record in records], ["Invoice"])
        self.assertEqual(lines, ["0 row Invoice"])
        self.assertFalse(truncation["truncated"])

    def test_node_limit_keeps_exact_prefix_and_truncation(self):
        root = FakeAccessible(
            "document",
            "Results",
            children=[FakeAccessible("text", f"Item {index}") for index in range(runtime.MAX_NODES)],
        )

        records, _, truncation = render(root)

        self.assertEqual(len(records), runtime.MAX_NODES)
        self.assertEqual(records[-1]["name"], f"Item {runtime.MAX_NODES - 2}")
        self.assertTrue(truncation["truncated"])
        self.assertFalse(truncation["maxDepthReached"])

    def test_depth_limit_keeps_exact_prefix_and_flag(self):
        root = FakeAccessible("document", "Depth 65")
        for depth in range(runtime.MAX_DEPTH, -1, -1):
            root = FakeAccessible("document", f"Depth {depth}", children=[root])

        records, _, truncation = render(root)

        self.assertEqual(len(records), runtime.MAX_DEPTH + 1)
        self.assertEqual(records[-1]["name"], f"Depth {runtime.MAX_DEPTH}")
        self.assertTrue(truncation["truncated"])
        self.assertTrue(truncation["maxDepthReached"])


class DesktopAppRuntimeTest(unittest.TestCase):
    def test_wayland_degrades_with_unsupported_capability(self):
        for environ in ({"XDG_SESSION_TYPE": "wayland", "DISPLAY": ":0"}, {"WAYLAND_DISPLAY": "wayland-0", "DISPLAY": ":0"}):
            reason = runtime.desktop_app_unsupported_reason(environ)
            self.assertTrue(reason.startswith("unsupported capability:"))
            self.assertIn("Wayland", reason)

    def test_x11_session_is_supported_and_missing_display_degrades(self):
        self.assertIsNone(runtime.desktop_app_unsupported_reason({"XDG_SESSION_TYPE": "x11", "DISPLAY": ":0"}))
        self.assertIsNone(runtime.desktop_app_unsupported_reason({"XDG_SESSION_TYPE": "x11", "WAYLAND_DISPLAY": "w", "DISPLAY": ":0"}))
        self.assertIn("DISPLAY", runtime.desktop_app_unsupported_reason({"XDG_SESSION_TYPE": "x11"}))

    def test_desktop_tools_report_wayland_instead_of_crashing(self):
        original = dict(runtime.os.environ)
        runtime.os.environ.update({"XDG_SESSION_TYPE": "wayland", "WAYLAND_DISPLAY": "wayland-0"})
        try:
            for operation in (
                {"tool": "list_desktop_windows"},
                {"tool": "desktop_input", "pid": 7, "windowId": 9, "input": {"kind": "text", "text": "a"}},
            ):
                with self.assertRaisesRegex(RuntimeError, "^unsupported capability:"):
                    runtime.run_operation(operation)
        finally:
            runtime.os.environ.clear()
            runtime.os.environ.update(original)

    def test_input_rejects_bad_targets_before_opening_the_display(self):
        with self.assertRaisesRegex(ValueError, "pid must be a positive integer"):
            runtime.desktop_input({"pid": 0, "windowId": 9, "input": {"kind": "text"}})
        with self.assertRaisesRegex(ValueError, "windowId must be a positive integer"):
            runtime.desktop_input({"pid": 7, "windowId": True, "input": {"kind": "text"}})
        with self.assertRaisesRegex(ValueError, "^invalid_argument:"):
            runtime.desktop_input({"pid": 7, "windowId": 9})

    def test_point_must_stay_inside_the_window(self):
        self.assertEqual(runtime.desktop_app_point_in_bounds(400, 300, 10.4, 20.6), (10, 21))
        with self.assertRaisesRegex(ValueError, "^invalid_argument:"):
            runtime.desktop_app_point_in_bounds(400, 300, 400, 1)
        with self.assertRaisesRegex(ValueError, "x must be a finite number"):
            runtime.desktop_app_point_in_bounds(400, 300, float("nan"), 1)

    def test_scroll_maps_pixels_to_wheel_buttons(self):
        self.assertEqual(runtime.desktop_app_scroll_buttons(0, 120), [(5, 2)])
        self.assertEqual(runtime.desktop_app_scroll_buttons(-30, -10), [(4, 1), (6, 1)])
        self.assertEqual(runtime.desktop_app_scroll_buttons(0.2, 0.4), [])
        self.assertEqual(runtime.desktop_app_scroll_buttons(0, 1e9), [(5, runtime.DESKTOP_APP_MAX_SCROLL_STEPS)])

    def test_key_spec_maps_primary_modifier_to_control(self):
        self.assertEqual(runtime.desktop_app_key_spec("shift+cmd+A"), ("a", runtime.X_SHIFT_MASK | runtime.X_CONTROL_MASK))
        self.assertEqual(runtime.desktop_app_key_spec("pagedown"), ("pagedown", 0))
        with self.assertRaisesRegex(ValueError, "unsupported modifier"):
            runtime.desktop_app_key_spec("hyper+a")

    def test_keysyms_follow_the_x11_unicode_rule(self):
        self.assertEqual(runtime.desktop_app_keysym_for_char("a"), 0x61)
        self.assertEqual(runtime.desktop_app_keysym_for_char("\u00e9"), 0xE9)
        self.assertEqual(runtime.desktop_app_keysym_for_char("\u20ac"), 0x010020AC)

    def test_blocklist_and_event_layout(self):
        self.assertTrue(runtime.desktop_app_is_blocked("Bitwarden", None, "Vault"))
        self.assertFalse(runtime.desktop_app_is_blocked("gedit", "gedit", "notes.txt"))
        if ctypes.sizeof(ctypes.c_void_p) == 8:
            # XEvent is a union padded to 24 longs; a smaller struct would let XSendEvent read past it.
            self.assertEqual(ctypes.sizeof(runtime.XEvent), 192)
            self.assertEqual(ctypes.sizeof(runtime.XWindowAttributes), 136)


class FakePointerSession:
    display = None
    root = 1

    def __init__(self, masks):
        self.masks = masks
        self.sent = []

    def child_at(self, window, root_x, root_y):
        return 7, root_x - 100, root_y - 50, [window, 7]

    def event_masks(self, window):
        return self.masks.get(window, 0)

    def send(self, window, event, mask):
        self.sent.append(event.input.type)


class DesktopAppPointerTest(unittest.TestCase):
    record = {"windowId": 5, "bounds": {"x": 100, "y": 50, "width": 400, "height": 300}}

    def test_double_click_sends_one_press_per_mouseup(self):
        session = FakePointerSession({5: runtime.X_BUTTON_PRESS_MASK})
        for count in (1, 2):
            runtime.desktop_app_click(session, self.record, {"x": 10, "y": 10, "button": "left", "clickCount": count})
        self.assertEqual(session.sent.count(runtime.X_BUTTON_PRESS), 2)

    def test_clicks_fail_loudly_when_no_window_selects_core_buttons(self):
        session = FakePointerSession({})
        with self.assertRaisesRegex(RuntimeError, "unsupported capability"):
            runtime.desktop_app_click(session, self.record, {"x": 10, "y": 10, "button": "left", "clickCount": 1})
        with self.assertRaisesRegex(RuntimeError, "unsupported capability"):
            runtime.desktop_app_scroll(session, self.record, {"x": 10, "y": 10, "deltaX": 0, "deltaY": 120})
        self.assertEqual(session.sent, [])

    def test_keys_fail_loudly_when_the_top_level_window_selects_no_key_events(self):
        session = FakePointerSession({})
        with self.assertRaisesRegex(RuntimeError, "unsupported capability"):
            runtime.desktop_app_send_key(session, self.record, 0x71, 0, group=0)
        self.assertEqual(session.sent, [])


class DesktopAppKeycodeTest(unittest.TestCase):
    def session(self, levels, groups=None, keycodes=None):
        # keycodes: keycode -> {group: [level 0, level 1, ...]}
        keycodes = keycodes or {24: groups or {0: levels}}

        def keysym_at(_display, keycode, group, level):
            row = keycodes.get(keycode, {}).get(group, [])
            return row[level] if level < len(row) else 0

        x = types.SimpleNamespace(XKeysymToKeycode=lambda _display, _keysym: 24, XkbKeycodeToKeysym=keysym_at)
        return types.SimpleNamespace(x=x, display=None, keycode_range=lambda: (8, 255))

    def test_uses_shift_only_for_the_shifted_level(self):
        self.assertEqual(runtime.desktop_app_keycode(self.session([0x71, 0x51]), 0x71), (24, False))
        self.assertEqual(runtime.desktop_app_keycode(self.session([0x71, 0x51]), 0x51), (24, True))

    def test_rejects_a_keysym_that_needs_altgr(self):
        self.assertIsNone(runtime.desktop_app_keycode(self.session([0x71, 0x51, 0x40]), 0x40))

    def test_looks_up_the_active_layout_group(self):
        session = self.session([], {0: [0x71, 0x51], 1: [0x6CA, 0x6EA]})
        self.assertIsNone(runtime.desktop_app_keycode(session, 0x6CA))
        self.assertEqual(runtime.desktop_app_keycode(session, 0x6CA, 1), (24, False))
        self.assertEqual(runtime.desktop_app_keycode(session, 0x6EA, 1), (24, True))

    def test_finds_another_keycode_that_has_the_keysym_in_the_group(self):
        session = self.session([], keycodes={24: {0: [0x71], 1: [0x6CA]}, 38: {1: [0x71, 0x51]}})
        self.assertEqual(runtime.desktop_app_keycode(session, 0x71, 0), (24, False))
        self.assertEqual(runtime.desktop_app_keycode(session, 0x51, 1), (38, True))
        self.assertIsNone(runtime.desktop_app_keycode(session, 0x40, 1))


if __name__ == "__main__":
    unittest.main()

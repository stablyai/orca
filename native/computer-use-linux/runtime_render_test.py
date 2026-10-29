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

    def test_click_activates_the_window_only_for_pointer_fallback(self):
        button = FakeAccessible("button", "Continue")
        button.get_n_actions = lambda: 1
        button.get_action_name = lambda _: "click"
        button.do_action = lambda _: True
        label = FakeAccessible("label", "Status")
        for target, expected_path, expected_calls in (
            (button, "accessibility", []),
            (label, "synthetic", ["restore", "pointer"]),
        ):
            with self.subTest(path=expected_path), SnapshotFixture(
                FakeAccessible("frame", "Editor", children=[button, label])
            ) as fixture:
                calls = []
                def restore():
                    calls.append("restore")
                    fixture.root.get_state_set = lambda: FakeStateSet(FakeStateType.ACTIVE)
                fixture.restore = restore
                snapshot = runtime.make_snapshot("Fixture", False)
                element = next(item for item in snapshot["elements"] if item["name"] == target.name)
                with patch.object(runtime, "click_at", lambda *_: calls.append("pointer")):
                    result = runtime.run_operation({"tool": "click", "app": "Fixture", "element": element, "noScreenshot": True})
                self.assertEqual(result["action"]["path"], expected_path)
                self.assertEqual(calls, expected_calls)

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

    def test_text_entry_inserts_into_the_focused_field_of_a_background_window(self):
        for tool in ("type_text", "paste_text"):
            for value in ("there", "élan", "🚀 café"):
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
            ("count-missing", None, (6, 11)),
            ("count-negative", -1, (6, 11)),
            ("multiple", 2, (6, 11)),
            ("range-error", 1, TimeoutError("range timed out")),
            ("range-missing", 1, None),
            ("range-empty", 1, (6, 6)),
            ("range-reversed", 1, (11, 6)),
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
                            (keys if tool == "type_text" else paste).assert_called_once_with("x")
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
        for tool in ("type_text", "paste_text"):
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
        for tool in ("type_text", "paste_text"):
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
        for tool in ("type_text", "paste_text"):
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


if __name__ == "__main__":
    unittest.main()

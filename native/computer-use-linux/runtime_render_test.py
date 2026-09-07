import importlib.util
import sys
import types
import unittest
from pathlib import Path


class FakeStateType:
    PROTECTED = 1
    SELECTED = 2


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
        raise RuntimeError("defunct node")


def render(root):
    return runtime.render_accessibility_tree(root, None, [0])


class RuntimeRenderTest(unittest.TestCase):
    def test_named_non_generic_node_skips_unused_summary_walk(self):
        root = FakeAccessible("button", "Save", children=[FakeAccessible("text", "unused")])

        records, lines, truncation = render(root)

        self.assertEqual([record["name"] for record in records], ["Save"])
        self.assertEqual(lines, ["0 button Save"])
        self.assertEqual(root.counter["child_reads"], 2)
        self.assertFalse(truncation["truncated"])

    def test_named_generic_node_skips_unused_summary_walk(self):
        root = FakeAccessible("section", "Details", children=[FakeAccessible("text", "body")])

        records, lines, _ = render(root)

        self.assertEqual([record["name"] for record in records], ["Details", "body"])
        self.assertEqual(lines, ["0 section Details", "\t1 text body"])
        self.assertEqual(root.counter["child_reads"], 3)

    def test_unnamed_generic_node_keeps_plain_text_summary(self):
        root = FakeAccessible(
            "section",
            children=[FakeAccessible("text", "Alpha"), FakeAccessible("text", "Beta")],
        )

        records, lines, _ = render(root)

        self.assertEqual(len(records), 1)
        self.assertEqual(lines, ["0 section, Text: Alpha Beta"])
        self.assertEqual(root.counter["child_reads"], 13)

    def test_row_keeps_its_specific_summary_walk(self):
        root = FakeAccessible(
            "row",
            "Invoice",
            children=[FakeAccessible("text", "Alpha"), FakeAccessible("text", "Beta")],
        )

        records, lines, _ = render(root)

        self.assertEqual([record["name"] for record in records], ["Invoice", "Alpha", "Beta"])
        self.assertEqual(lines, ["0 row Invoice, Text: Alpha Beta", "\t1 text Alpha", "\t2 text Beta"])
        self.assertEqual(root.counter["child_reads"], 10)

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

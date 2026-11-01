import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest import mock


def load_runtime():
    editable_text = types.SimpleNamespace(set_text_contents=lambda editable, value: editable.update(text=value) or True)
    repository = types.ModuleType("gi.repository")
    repository.Atspi = types.SimpleNamespace(EditableText=editable_text)
    gi = types.ModuleType("gi")
    gi.repository = repository
    gi.require_version = lambda *_: None
    path = Path(__file__).with_name("runtime.py")
    with mock.patch.dict(sys.modules, {"gi": gi, "gi.repository": repository}):
        spec = importlib.util.spec_from_file_location("orca_linux_runtime_set_value_test", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


class SetValueTest(unittest.TestCase):
    def test_sets_text_on_bindings_without_is_editable_text(self):
        # Why: at-spi2-core < 2.53 (e.g. Ubuntu 24.04) does not expose Accessible.is_editable_text to GI.
        editable = {"text": ""}
        node = types.SimpleNamespace(get_editable_text_iface=lambda: editable, get_value_iface=lambda: None)

        self.assertTrue(load_runtime().set_value(node, "hello"))
        self.assertEqual(editable["text"], "hello")


if __name__ == "__main__":
    unittest.main()

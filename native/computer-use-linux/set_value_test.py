# Why: set_value must not touch Accessible.is_editable_text (not in Python GI).
# This module-level unit test stubs ATSPI and exercises the iface probe path.
from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest import mock


def load_runtime_with_stub_atspi():
    atspi = types.ModuleType("gi.repository.Atspi")

    class EditableText:
        @staticmethod
        def set_text_contents(editable, value):
            editable["text"] = value
            return True

    class Value:
        @staticmethod
        def set_current_value(iface, value):
            iface["value"] = value
            return True

    atspi.EditableText = EditableText
    atspi.Value = Value

    gi = types.ModuleType("gi")
    repository = types.ModuleType("gi.repository")
    repository.Atspi = atspi
    gi.repository = repository
    gi.require_version = lambda *args, **kwargs: None

    sys.modules["gi"] = gi
    sys.modules["gi.repository"] = repository
    sys.modules["gi.repository.Atspi"] = atspi

    path = Path(__file__).with_name("runtime.py")
    spec = importlib.util.spec_from_file_location("computer_use_linux_runtime", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    with mock.patch.dict(sys.modules, {"gi": gi, "gi.repository": repository, "gi.repository.Atspi": atspi}):
        # runtime imports Atspi at module load via from gi.repository import Atspi
        # Inject before exec
        pass
    # Re-exec with modules already registered
    source = path.read_text(encoding="utf-8")
    # Provide minimal globals after stubbing gi
    module_globals = {
        "__name__": "computer_use_linux_runtime",
        "__file__": str(path),
    }
    # Execute only through importlib after gi is in sys.modules
    sys.modules.pop("computer_use_linux_runtime", None)
    spec = importlib.util.spec_from_file_location("computer_use_linux_runtime", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class SetValueTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.runtime = load_runtime_with_stub_atspi()

    def test_set_value_uses_editable_text_iface_without_is_editable_text(self):
        editable = {"text": ""}

        class Node:
            def get_editable_text_iface(self):
                return editable

            def get_value_iface(self):
                return None

        node = Node()
        # Ensure the broken attribute is absent (mirrors real GI bindings).
        self.assertFalse(hasattr(node, "is_editable_text"))
        self.assertTrue(self.runtime.set_value(node, "hello"))
        self.assertEqual(editable["text"], "hello")

    def test_set_value_falls_back_to_value_iface(self):
        value_iface = {"value": 0.0}

        class Node:
            def get_editable_text_iface(self):
                return None

            def get_value_iface(self):
                return value_iface

        self.assertTrue(self.runtime.set_value(Node(), "3.5"))
        self.assertEqual(value_iface["value"], 3.5)

    def test_set_value_returns_false_when_no_ifaces(self):
        class Node:
            def get_editable_text_iface(self):
                return None

            def get_value_iface(self):
                return None

        self.assertFalse(self.runtime.set_value(Node(), "x"))


if __name__ == "__main__":
    unittest.main()

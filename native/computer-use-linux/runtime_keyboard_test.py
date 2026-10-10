import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest import mock


class FakeKeySynthType:
    PRESSRELEASE = "pressrelease"
    SYM = "sym"
    STRING = "string"


KEYSYMS = {"Return": 0xFF0D, "Tab": 0xFF09, "Escape": 0xFF1B, "Left": 0xFF51, "Down": 0xFF54}


def load_runtime():
    gi = types.ModuleType("gi")
    repository = types.ModuleType("gi.repository")
    gi.require_version = lambda *_: None
    repository.Atspi = types.SimpleNamespace(KeySynthType=FakeKeySynthType, generate_keyboard_event=None)
    repository.Gdk = types.SimpleNamespace(keyval_from_name=KEYSYMS.__getitem__)
    repository.GdkPixbuf = types.SimpleNamespace()
    gi.repository = repository
    sys.modules["gi"] = gi
    sys.modules["gi.repository"] = repository

    path = Path(__file__).with_name("runtime.py")
    spec = importlib.util.spec_from_file_location("orca_linux_runtime_keyboard_test", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


runtime = load_runtime()


class RuntimeKeyboardTest(unittest.TestCase):
    def setUp(self):
        self.events = []
        patcher = mock.patch.object(
            runtime.Atspi, "generate_keyboard_event", lambda *args: self.events.append(args)
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_named_keys_synthesize_the_keysym(self):
        for raw, keysym in (("enter", 0xFF0D), ("Tab", 0xFF09), ("esc", 0xFF1B), ("left", 0xFF51), ("Down", 0xFF54)):
            self.events.clear()
            runtime.press_key(raw)
            self.assertEqual(self.events, [(keysym, None, FakeKeySynthType.SYM)], raw)

    def test_single_character_keys_still_type_the_character(self):
        runtime.press_key("A")

        self.assertEqual(self.events, [(0, "A", FakeKeySynthType.STRING)])

    def run_hotkey(self, raw):
        with mock.patch.object(runtime.shutil, "which", return_value="/usr/bin/xdotool"), mock.patch.object(
            runtime.subprocess, "run"
        ) as run:
            runtime.hotkey(raw)
        return run.call_args.args[0]

    def test_hotkey_lowercases_letters_so_xdotool_does_not_add_shift(self):
        self.assertEqual(self.run_hotkey("CmdOrCtrl+A"), ["/usr/bin/xdotool", "key", "ctrl+a"])
        self.assertEqual(self.run_hotkey("ctrl+shift+T"), ["/usr/bin/xdotool", "key", "ctrl+shift+t"])

    def test_hotkey_keeps_named_keys_and_lone_keys(self):
        self.assertEqual(self.run_hotkey("alt+Tab"), ["/usr/bin/xdotool", "key", "alt+Tab"])
        self.assertEqual(self.run_hotkey("A"), ["/usr/bin/xdotool", "key", "A"])


if __name__ == "__main__":
    unittest.main()

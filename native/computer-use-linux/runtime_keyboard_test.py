import importlib.util
import os
import signal
import subprocess
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path


def load_runtime():
    gi = types.ModuleType("gi")
    repository = types.ModuleType("gi.repository")
    gi.require_version = lambda *_: None
    repository.Atspi = types.SimpleNamespace(set_timeout=lambda *_: None)
    repository.Gdk = types.SimpleNamespace()
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



    @unittest.skipIf(sys.platform == "win32", "the Linux bridge uses POSIX termination")
    def test_termination_stops_the_typing_child(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            child_pid = root / "child.pid"
            stand_in = root / "xdotool"
            stand_in.write_text(
                f"#!{sys.executable}\nimport os, time\n"
                f"open({str(child_pid)!r}, 'w').write(str(os.getpid()))\ntime.sleep(60)\n"
            )
            stand_in.chmod(0o700)
            operation = root / "operation.json"
            operation.write_text("{}")
            source = (
                "import sys, contextlib\n"
                f"sys.path.insert(0, {str(Path(__file__).parent)!r})\n"
                "from runtime_keyboard_test import runtime\n"
                f"runtime.shutil.which = lambda _: {str(stand_in)!r}\n"
                "runtime.temporary_x11_keymap = lambda *_: contextlib.nullcontext(None)\n"
                "runtime.run_operation = lambda _: runtime.type_text('Hello')\n"
                f"sys.argv = ['runtime.py', {str(operation)!r}]\n"
                "runtime.main()\n"
            )
            parent = subprocess.Popen([sys.executable, "-c", source], start_new_session=True,
                                      env={**os.environ, "XDG_SESSION_TYPE": "x11",
                                           "XDG_RUNTIME_DIR": directory, "DBUS_SESSION_BUS_ADDRESS": "test"})
            pid = None
            try:
                deadline = time.monotonic() + 5
                while not child_pid.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(child_pid.exists(), "typing stand-in did not start")
                pid = int(child_pid.read_text())
                parent.send_signal(signal.SIGTERM)
                parent.wait(timeout=3)
                with self.assertRaises(ProcessLookupError):
                    os.kill(pid, 0)
            finally:
                if parent.poll() is None:
                    parent.kill()
                parent.wait(timeout=3)
                if pid is not None:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass





if __name__ == "__main__":
    unittest.main()

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

RUNTIME = Path(__file__).with_name("runtime.py")


@unittest.skipUnless(sys.platform.startswith("linux"), "drives the real libatspi")
class AccessibilityBusTest(unittest.TestCase):
    """Runs the bridge against real libatspi in a private runtime dir, never the desktop's buses."""

    def run_list_apps(self, runtime_dir, env, prefix=()):
        operation = os.path.join(runtime_dir, "operation.json")
        with open(operation, "w", encoding="utf-8") as handle:
            json.dump({"tool": "list_apps"}, handle)
        env = {**env, "XDG_RUNTIME_DIR": runtime_dir}
        # Why files, not pipes: bus daemons the session activates inherit them and can outlive the bridge.
        with tempfile.TemporaryFile("w+") as stdout, tempfile.TemporaryFile("w+") as stderr:
            result = subprocess.run([*prefix, sys.executable, str(RUNTIME), operation],
                                    env=env, stdout=stdout, stderr=stderr, timeout=60)
            stdout.seek(0)
            stderr.seek(0)
            return subprocess.CompletedProcess(result.args, result.returncode, stdout.read(), stderr.read())

    def test_unreachable_bus_returns_an_error_instead_of_aborting(self):
        with tempfile.TemporaryDirectory() as runtime_dir:
            missing = "unix:path=" + os.path.join(runtime_dir, "missing-bus")
            result = self.run_list_apps(runtime_dir, {**os.environ, "DBUS_SESSION_BUS_ADDRESS": missing,
                                                      "AT_SPI_BUS_ADDRESS": missing})
        self.assertEqual(result.returncode, 0, result.stderr)
        response = json.loads(result.stdout)
        self.assertFalse(response["ok"])
        self.assertTrue(response["error"].startswith("unsupported_capability:"), response["error"])



if __name__ == "__main__":
    unittest.main()

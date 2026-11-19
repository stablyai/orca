import importlib.util
import shutil
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
    repository.Atspi = types.SimpleNamespace()
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


if __name__ == "__main__":
    unittest.main()

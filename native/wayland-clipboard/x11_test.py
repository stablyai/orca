import os
import select
import subprocess
import sys
import tempfile
import unittest

from protocol_test import DataControlServer

BINARY = os.path.abspath(sys.argv.pop(1))


class X11PublisherTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="orca-clipboard-x11-")
        reader, writer = os.pipe()
        cls.display = subprocess.Popen(
            ["Xvfb", "-displayfd", str(writer), "-screen", "0", "640x480x24", "-nolisten", "tcp"],
            pass_fds=[writer], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        os.close(writer)
        try:
            if not select.select([reader], [], [], 5)[0]:
                raise RuntimeError("Private X server did not start")
            number = os.read(reader, 32).decode().strip()
            if not number.isdecimal():
                raise RuntimeError("Invalid private display number")
            cls.env = {**os.environ, "DISPLAY": ":" + number, "GDK_BACKEND": "wayland",
                       "XAUTHORITY": os.path.join(cls.directory.name, "unused-authority"),
                       "ORCA_BACKGROUND_LAUNCH": "1"}
        except BaseException:
            cls.tearDownClass()
            raise
        finally:
            os.close(reader)

    @classmethod
    def tearDownClass(cls):
        cls.display.terminate()
        cls.display.wait(timeout=5)
        cls.directory.cleanup()

    def copy(self, text):
        with DataControlServer(None) as server:
            result = subprocess.run([BINARY], input=text, capture_output=True,
                                    env={**server.environment(), **self.env,
                                         "XDG_RUNTIME_DIR": server.directory.name,
                                         "WAYLAND_DISPLAY": "wayland-test"}, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, b"")
            self.assertTrue(server.disconnected.wait(1))

    def read(self):
        result = subprocess.run(["xclip", "-selection", "clipboard", "-out", "-target", "UTF8_STRING"],
                                capture_output=True, env=self.env, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_preserves_empty_unicode_crlf_and_large_incremental_transfers(self):
        for text in (b"", "遥か\r\n雪\n".encode(), b"before\0after", b"x" * (16 * 1024 * 1024)):
            with self.subTest(length=len(text)):
                self.copy(text)
                self.assertEqual(self.read(), text)
                self.assertEqual(self.read(), text)

    def test_repeated_owners_survive_parent_exit_and_publish_in_order(self):
        for index in range(20):
            text = ("copy " + str(index)).encode()
            self.copy(text)
            self.assertEqual(self.read(), text)


if __name__ == "__main__":
    unittest.main()

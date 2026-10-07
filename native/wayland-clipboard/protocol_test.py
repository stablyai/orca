import array
import fcntl
import os
import select
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest

BINARY = os.path.abspath(sys.argv.pop(1))


def number(value):
    return struct.pack("=I", value)


def string(value):
    encoded = value.encode() + b"\0"
    return number(len(encoded)) + encoded + b"\0" * (-len(encoded) % 4)


class DataControlServer:
    def __init__(self, protocol, selection_event=None):
        self.protocol = protocol
        self.selection_event = selection_event
        self.directory = tempfile.TemporaryDirectory(prefix="orca-clipboard-protocol-")
        self.socket = socket.socket(socket.AF_UNIX)
        self.socket.bind(os.path.join(self.directory.name, "wayland-test"))
        self.socket.listen(1)
        self.socket.settimeout(5)
        self.objects = {1: "display"}
        self.source = None
        self.registry = None
        self.device = None
        self.destroyed_offers = []
        self.selected = threading.Event()
        self.disconnected = threading.Event()
        self.errors = []
        self.connection = None
        self.lock = threading.Lock()
        self.thread = threading.Thread(target=self.serve, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_args):
        if self.connection:
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.connection.close()
        self.socket.close()
        self.thread.join(6)
        self.directory.cleanup()
        if self.errors:
            raise self.errors[0]

    def environment(self):
        return {**os.environ, "ORCA_BACKGROUND_LAUNCH": "1", "XDG_RUNTIME_DIR": self.directory.name,
                "WAYLAND_DISPLAY": "wayland-test"}

    def send(self, object_id, opcode, body=b"", fd=None):
        packet = number(object_id) + number(((len(body) + 8) << 16) | opcode) + body
        with self.lock:
            if fd is None:
                self.connection.sendall(packet)
            else:
                sent = self.connection.sendmsg([packet], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [fd]))])
                if sent != len(packet):
                    raise RuntimeError("Partial protocol event")

    def serve(self):
        try:
            self.connection, _address = self.socket.accept()
            buffered = b""
            while True:
                chunk = self.connection.recv(4096)
                if not chunk:
                    break
                buffered += chunk
                while len(buffered) >= 8:
                    object_id, header = struct.unpack("=II", buffered[:8])
                    size, opcode = header >> 16, header & 65535
                    if len(buffered) < size:
                        break
                    self.request(object_id, opcode, buffered[8:size])
                    buffered = buffered[size:]
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            self.errors.append(error)
        finally:
            self.disconnected.set()

    def request(self, object_id, opcode, body):
        kind = self.objects[object_id]
        if kind == "display" and opcode == 1:
            registry = struct.unpack("=I", body)[0]
            self.registry = registry
            self.objects[registry] = "registry"
            self.send(registry, 0, number(10) + string("wl_seat") + number(1))
            if self.protocol:
                self.send(registry, 0, number(20) + string(self.protocol + "_manager_v1") + number(1))
        elif kind == "display" and opcode == 0:
            callback = struct.unpack("=I", body)[0]
            self.send(callback, 0, number(123))
            self.send(1, 1, number(callback))
        elif kind == "registry":
            interface_length = struct.unpack("=I", body[4:8])[0]
            interface = body[8:8 + interface_length - 1].decode()
            new_id = struct.unpack("=I", body[-4:])[0]
            self.objects[new_id] = "seat" if interface == "wl_seat" else "manager"
        elif kind == "manager":
            new_id = struct.unpack("=I", body[:4])[0]
            self.objects[new_id] = "source" if opcode == 0 else "device"
            if opcode == 1:
                self.device = new_id
        elif kind == "device" and opcode == 0:
            if len(body) != 4:
                raise RuntimeError("Selection unexpectedly carries an input serial")
            self.source = struct.unpack("=I", body)[0]
            self.selected.set()
            if self.selection_event == "cancelled":
                self.send(self.source, 1)
            elif self.selection_event == "finished":
                self.send(self.device, 2)
            elif self.selection_event == "seat removal":
                self.send(self.registry, 1, number(10))
        elif kind == "offer" and opcode == 1:
            self.destroyed_offers.append(object_id)
        elif kind != "source":
            raise RuntimeError(f"Unexpected request {kind}/{opcode}")

    def copy(self, text, extra_env=None):
        result = subprocess.run([BINARY], input=text, capture_output=True,
                                env={**self.environment(), **(extra_env or {})}, timeout=5)
        if result.returncode == 0 and not self.selected.wait(2):
            raise RuntimeError("Helper exited without publishing a source")
        return result

    def request_paste(self, pipe_size=None):
        reader, writer = os.pipe()
        try:
            if pipe_size:
                # Python 3.8 omits this Linux UAPI constant.
                fcntl.fcntl(writer, getattr(fcntl, "F_SETPIPE_SZ", 1031), pipe_size)
            self.send(self.source, 0, string("text/plain;charset=utf-8") + number(0), writer)
        finally:
            os.close(writer)
        return reader

    def paste(self):
        reader = self.request_paste()
        result = bytearray()
        deadline = time.monotonic() + 3
        try:
            while select.select([reader], [], [], max(0, deadline - time.monotonic()))[0]:
                chunk = os.read(reader, 65536)
                if not chunk:
                    return bytes(result)
                result.extend(chunk)
            raise RuntimeError("Paste did not complete")
        finally:
            os.close(reader)


class ClipboardProtocolTests(unittest.TestCase):
    def test_both_protocols_preserve_bytes_and_serve_repeated_pastes(self):
        text = ("遥か\r\nline two\n" * 20000).encode()
        for protocol in ("zwlr_data_control", "ext_data_control"):
            with self.subTest(protocol=protocol), DataControlServer(protocol) as server:
                self.assertEqual(server.copy(text).returncode, 0)
                self.assertEqual(server.paste(), text)
                self.assertEqual(server.paste(), text)
                server.send(server.source, 1)
                self.assertTrue(server.disconnected.wait(1))

    def test_unsupported_protocol_never_publishes_or_creates_a_popup(self):
        with DataControlServer(None) as server:
            result = server.copy(b"private text")
            self.assertEqual(result.returncode, 78)
            self.assertIsNone(server.source)
            self.assertEqual(result.stdout, b"")

    def test_missing_display_rejects_without_echoing_text(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run([BINARY], input=b"private text", capture_output=True,
                                    env={**os.environ, "XDG_RUNTIME_DIR": directory, "WAYLAND_DISPLAY": "missing"}, timeout=3)
            self.assertEqual(result.returncode, 69)
            self.assertNotIn(b"private text", result.stdout + result.stderr)

    def test_size_limit_precedes_selection_publication(self):
        with DataControlServer("ext_data_control") as server:
            self.assertEqual(server.copy(b"x" * (16 * 1024 * 1024 + 1)).returncode, 65)
            self.assertIsNone(server.source)

    def test_probe_does_not_write(self):
        with DataControlServer("ext_data_control") as server:
            result = subprocess.run([BINARY, "--probe"], capture_output=True, env=server.environment(), timeout=3)
            self.assertEqual(result.returncode, 0)
            self.assertIsNone(server.source)

    def test_replacement_during_ack_is_success_but_device_loss_is_failure(self):
        for event, status in (("cancelled", 0), ("finished", 70), ("seat removal", 70)):
            with self.subTest(event=event), DataControlServer("ext_data_control", event) as server:
                self.assertEqual(server.copy(b"copy").returncode, status)
                self.assertTrue(server.disconnected.wait(1))

    def test_owner_startup_failure_reaches_the_parent(self):
        with tempfile.TemporaryDirectory() as directory:
            source = os.path.join(directory, "failed-owner.c")
            library = os.path.join(directory, "failed-owner.so")
            with open(source, "w") as file:
                file.write('''#define _GNU_SOURCE
#include <dlfcn.h>
#include <unistd.h>
pid_t fork(void) {
    pid_t (*actual)(void) = dlsym(RTLD_NEXT, "fork");
    pid_t pid = actual();
    if (pid == 0) _exit(71);
    return pid;
}
''')
            subprocess.run(["cc", "-shared", "-fPIC", source, "-ldl", "-o", library], check=True, timeout=10)
            with DataControlServer("ext_data_control") as server:
                self.assertEqual(server.copy(b"copy", {"LD_PRELOAD": library}).returncode, 71)
                self.assertTrue(server.disconnected.wait(1))

    def test_slow_progressing_paste_is_not_truncated(self):
        text = b"x" * (128 * 1024)
        with DataControlServer("ext_data_control") as server:
            self.assertEqual(server.copy(text).returncode, 0)
            reader = server.request_paste(pipe_size=8192)
            received = bytearray()
            try:
                while select.select([reader], [], [], 1)[0]:
                    chunk = os.read(reader, 4096)
                    if not chunk:
                        break
                    received.extend(chunk)
                    time.sleep(.08)
                self.assertEqual(received, text)
            finally:
                os.close(reader)
            server.send(server.source, 1)
            self.assertTrue(server.disconnected.wait(1))

    def test_stalled_receiver_does_not_block_cancellation(self):
        with DataControlServer("ext_data_control") as server:
            self.assertEqual(server.copy(b"x" * 1024 * 1024).returncode, 0)
            stalled = server.request_paste()
            try:
                server.send(server.source, 1)
                self.assertTrue(server.disconnected.wait(1))
            finally:
                os.close(stalled)

    def test_incoming_clipboard_and_primary_offers_are_released(self):
        with DataControlServer("ext_data_control") as server:
            self.assertEqual(server.copy(b"copy").returncode, 0)
            for index, event in enumerate((1, 3)):
                offer = 0xFF000000 + index
                server.objects[offer] = "offer"
                server.send(server.device, 0, number(offer))
                server.send(offer, 0, string("text/plain"))
                server.send(server.device, event, number(offer))
            self.assertEqual(server.paste(), b"copy")
            deadline = time.monotonic() + 1
            while len(server.destroyed_offers) < 2 and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertEqual(server.destroyed_offers, [0xFF000000, 0xFF000001])
            server.send(server.source, 1)
            self.assertTrue(server.disconnected.wait(1))

    def test_device_finished_and_seat_removal_stop_the_owner(self):
        for event in ("finished", "seat removal"):
            with self.subTest(event=event), DataControlServer("zwlr_data_control") as server:
                self.assertEqual(server.copy(b"copy").returncode, 0)
                if event == "finished":
                    server.send(server.device, 2)
                else:
                    server.send(server.registry, 1, number(10))
                self.assertTrue(server.disconnected.wait(1))

    def test_stalled_transfers_are_bounded_and_expire(self):
        with DataControlServer("zwlr_data_control") as server:
            self.assertEqual(server.copy(b"x" * 1024 * 1024).returncode, 0)
            readers = [server.request_paste() for _ in range(9)]
            try:
                self.assertTrue(select.select([readers[-1]], [], [], 1)[0])
                self.assertEqual(os.read(readers[-1], 1), b"")
                time.sleep(2.2)
                for reader in readers[:-1]:
                    os.set_blocking(reader, False)
                    while os.read(reader, 65536):
                        pass
                self.assertEqual(server.paste(), b"x" * 1024 * 1024)
                server.send(server.source, 1)
                self.assertTrue(server.disconnected.wait(1))
            finally:
                for reader in readers:
                    os.close(reader)


if __name__ == "__main__":
    unittest.main()

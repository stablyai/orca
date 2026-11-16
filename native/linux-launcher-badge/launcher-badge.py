#!/usr/bin/env python3
"""Orca Linux launcher badge helper.

Docks that implement the Unity LauncherEntry API (Ubuntu Dock, dash-to-dock,
KDE Plasma task manager) draw a count bubble on an app icon when a session-bus
peer emits ``com.canonical.Unity.LauncherEntry.Update`` for the app's desktop
file. They drop the entry as soon as the emitting connection disappears, so the
emitter must outlive the badge: this process holds one connection for Orca's
lifetime, reads one non-negative integer per line from stdin and republishes
it. EOF, SIGTERM or SIGINT hides the badge before exiting, so a crashed parent
never leaves a stale count behind.

A dock that restarts while Orca stays open (extension disabled and enabled,
shell reload) comes back with no launcher state and has missed every earlier
signal. Docks take the ``com.canonical.Unity`` bus name when they start, so the
helper replays the current count each time that name gains an owner, the same
way libunity does.

Usage: launcher-badge.py <desktop-file-name>   (for example ``orca-ide.desktop``)
Exit codes: 0 clean, 2 unsupported host (no python3-gi or no session bus), 64 usage.
"""

import os
import signal
import sys

try:
    import gi

    gi.require_version("Gio", "2.0")
    from gi.repository import Gio, GLib
except (ImportError, ValueError) as error:
    print(f"launcher-badge: GObject introspection unavailable: {error}", file=sys.stderr)
    sys.exit(2)

LAUNCHER_ENTRY_INTERFACE = "com.canonical.Unity.LauncherEntry"
LAUNCHER_ENTRY_PATH_PREFIX = "/com/canonical/unity/launcherentry/"
DOCK_BUS_NAME = "com.canonical.Unity"
STDIN_READ_BYTES = 4096


def object_path_for(desktop_file_name: str) -> str:
    """Mirror libunity: one object path per desktop id, non-alphanumerics folded to underscores."""
    stem = desktop_file_name[:-8] if desktop_file_name.endswith(".desktop") else desktop_file_name
    folded = "".join(char if char.isalnum() else "_" for char in stem)
    return LAUNCHER_ENTRY_PATH_PREFIX + folded


def parse_count(line: str):
    text = line.strip()
    if not text.isdigit():
        return None
    return int(text)


class LauncherBadge:
    def __init__(self, bus, desktop_file_name: str):
        self._bus = bus
        self._app_uri = f"application://{desktop_file_name}"
        self._path = object_path_for(desktop_file_name)

    def publish(self, count: int) -> None:
        properties = {
            "count": GLib.Variant("x", count),
            "count-visible": GLib.Variant("b", count > 0),
        }
        self._bus.emit_signal(
            None,
            self._path,
            LAUNCHER_ENTRY_INTERFACE,
            "Update",
            GLib.Variant("(sa{sv})", (self._app_uri, properties)),
        )
        self._bus.flush_sync(None)


def main(argv) -> int:
    if len(argv) != 2 or not argv[1].endswith(".desktop"):
        print(__doc__, file=sys.stderr)
        return 64

    try:
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    except GLib.Error as error:
        print(f"launcher-badge: no session bus: {error.message}", file=sys.stderr)
        return 2

    badge = LauncherBadge(bus, argv[1])
    loop = GLib.MainLoop()
    current = {"count": 0}
    pending = bytearray()

    def publish(count: int) -> None:
        current["count"] = count
        badge.publish(count)

    def consume(line: bytes) -> None:
        text = line.decode("utf-8", "replace")
        count = parse_count(text)
        if count is None:
            print(f"launcher-badge: ignoring malformed count {text.strip()!r}", file=sys.stderr)
            return
        publish(count)

    def on_stdin(fd, _condition):
        chunk = os.read(fd, STDIN_READ_BYTES)
        if not chunk:
            if pending:
                consume(bytes(pending))
            loop.quit()
            return GLib.SOURCE_REMOVE
        pending.extend(chunk)
        while True:
            newline = pending.find(b"\n")
            if newline < 0:
                break
            line = bytes(pending[:newline])
            del pending[: newline + 1]
            consume(line)
        return GLib.SOURCE_CONTINUE

    def on_dock_appeared(_connection, _name, _owner):
        # A hidden badge needs no replay: a dock that just started shows none.
        if current["count"] > 0:
            badge.publish(current["count"])

    def on_signal():
        loop.quit()
        return GLib.SOURCE_REMOVE

    # The main loop, not a blocking stdin read, so a dock restart is handled between counts.
    GLib.unix_fd_add_full(
        GLib.PRIORITY_DEFAULT, sys.stdin.fileno(), GLib.IO_IN | GLib.IO_HUP, on_stdin
    )
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signum, on_signal)
    Gio.bus_watch_name_on_connection(
        bus, DOCK_BUS_NAME, Gio.BusNameWatcherFlags.NONE, on_dock_appeared, None
    )

    try:
        loop.run()
    finally:
        try:
            badge.publish(0)
        except GLib.Error:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

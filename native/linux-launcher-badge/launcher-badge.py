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

Usage: launcher-badge.py <desktop-file-name>   (for example ``orca-ide.desktop``)
Exit codes: 0 clean, 2 unsupported host (no python3-gi or no session bus), 64 usage.
"""

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

    def hide_and_exit(_signum, _frame):
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, hide_and_exit)
    signal.signal(signal.SIGINT, hide_and_exit)
    signal.signal(signal.SIGHUP, hide_and_exit)

    try:
        for line in sys.stdin:
            count = parse_count(line)
            if count is None:
                print(f"launcher-badge: ignoring malformed count {line.strip()!r}", file=sys.stderr)
                continue
            badge.publish(count)
    finally:
        try:
            badge.publish(0)
        except GLib.Error:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

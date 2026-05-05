#!/usr/bin/env python3
"""Simulates a ratatui alt-screen TUI (like Codex) for reattach testing.

Behavior mimicked:
- Enters alternate screen buffer
- Enables bracketed paste mode
- Renders content with absolute cursor positioning (like ratatui cell-diffing)
- On SIGWINCH: reads terminal size, clears viewport, full repaint
- Emits OSC marker after each render so tests can synchronize
"""
import sys
import os
import signal
import time


def get_size():
    try:
        cols, rows = os.get_terminal_size()
        return cols, rows
    except Exception:
        return 80, 24


render_count = 0


def render(cols, rows):
    global render_count
    render_count += 1
    label = "initial" if render_count == 1 else f"render-{render_count}"

    # Synchronized update mode (crossterm uses this)
    sys.stdout.write("\x1b[?2026h")

    # ratatui terminal.clear(): MoveTo(viewport_origin) + Clear(FromCursorDown)
    # For fullscreen alt-screen, viewport origin is (0, 0)
    sys.stdout.write("\x1b[1;1H\x1b[J")

    # ratatui flush() with cell-diffing — absolute positioning per line
    sys.stdout.write(f"\x1b[1;1Hgpt-5.4 default \xc2\xb7 ~/test-workspace")
    sys.stdout.write(f"\x1b[2;1H")
    sys.stdout.write(f"\x1b[3;1Htest123 ({label})")
    sys.stdout.write(f"\x1b[4;1H")
    sys.stdout.write(f"\x1b[5;1H> {cols}x{rows}")

    # End synchronized update
    sys.stdout.write("\x1b[?2026l")
    sys.stdout.flush()

    # Marker so the test can detect render completion
    sys.stdout.write(f"\x1b]777;render-done-{render_count}\x07")
    sys.stdout.flush()


def main():
    # Enter alternate screen (like crossterm enable_raw_mode + EnterAlternateScreen)
    sys.stdout.write("\x1b[?1049h")
    # Enable bracketed paste
    sys.stdout.write("\x1b[?2004h")
    sys.stdout.flush()

    cols, rows = get_size()
    render(cols, rows)

    def handle_sigwinch(_signum, _frame):
        c, r = get_size()
        render(c, r)

    signal.signal(signal.SIGWINCH, handle_sigwinch)

    # Keep alive
    try:
        while True:
            time.sleep(10)
    except KeyboardInterrupt:
        pass
    finally:
        # Exit alternate screen
        sys.stdout.write("\x1b[?1049l")
        sys.stdout.flush()


if __name__ == "__main__":
    main()

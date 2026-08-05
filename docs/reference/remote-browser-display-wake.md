# Remote browser display wake

Mobile and other remote clients stream host Chromium pages through
`browser.screencast` (CDP frames). When the host **display** is asleep, the
compositor often parks and frames stop even though PTYs and RPC still work.

## Behavior

When the first live screencast starts, Orca:

1. **Wake-on-demand** — macOS: `caffeinate -u` (turns the display on if it was
   already off). Linux: best-effort `xset dpms force on` when `DISPLAY` is set.
2. **Hold awake** — Electron `prevent-display-sleep` plus the same macOS/Linux
   sleep assertions used by agent-awake, only while at least one screencast is
   live.
3. Temporarily disables main-window background throttling for that window while
   streaming, then restores the default when idle.

When the last screencast ends, assertions are released so an idle host can sleep
again.

## Caveats

- **Screen lock:** Remote browsing streams the page's WebContents, not the
  desktop framebuffer. Unlocking is usually **not** required. Waking the display
  may still **light the lock screen** on the host (privacy in shared spaces).
- **Lid closed / clamshell / battery policies:** Some machines refuse to fully
  wake the panel without local interaction. Prefer an open lid, AC power, or a
  headless/`orca serve` host with a virtual display when you need this path
  reliably.
- **Windows:** Wake-from-display-off is weaker; `prevent-display-sleep` is still
  applied while streaming.
- **Full system sleep / hibernation:** If the user session is suspended, wake
  display alone is not enough — keep the machine from full sleep (or use a
  server that stays running).

## Related

- Agent keep-awake (settings): same prevent-display-sleep / `caffeinate` family
  while agents are running.
- Headless Linux browser panes: [Headless Linux Server](./headless-linux-server.md)
  (Xvfb / virtual display for `orca serve`).

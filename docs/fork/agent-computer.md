# Shared agent computer (Phase 5)

A real Linux desktop on a machine (e.g. the VPS) that the owner watches and drives from Orca and that
every agent on that machine shares. Optional per machine: nothing runs until `install` is run there.

## What runs

`config/orca-fork/agent-computer/agent-computer.sh` (a systemd user service, `orca-agent-computer`):

- `Xtigervnc :42` (X server + VNC in one, 1440×900) with an XFCE session. VNC listens **only on a 0600
  Unix socket** (`-rfbunixpath`, `-rfbport -1`), VncAuth with a random password kept in
  `~/.local/state/orca-fork/agent-computer/` (mode 0700).
- `websockify` + noVNC on **127.0.0.1:6080** only. No port is opened to the internet.

`agent-computer-mcp.mjs` — a dependency-free stdio MCP server registered for Claude Code (and Codex
if installed) with `DISPLAY=:42`:

| Tool                  | Does                                                      |
| --------------------- | --------------------------------------------------------- |
| `computer_screenshot` | JPEG of the screen (its pixels are the click coordinates) |
| `computer_click`      | left/middle/right, optional double click at (x, y)        |
| `computer_drag`       | press at (x, y), release at (to_x, to_y)                  |
| `computer_type`       | type text at the focus                                    |
| `computer_key`        | keys/combos (`Return`, `ctrl+l`, `ctrl+shift+t Escape`)   |
| `computer_scroll`     | scroll up/down/left/right at (x, y)                       |
| `computer_open_url`   | open a URL in the desktop's Chromium/Firefox              |
| `computer_info`       | screen size, pointer and active window                    |

Agents can also export `DISPLAY=:42` and use Orca's own `orca computer …` (AT-SPI) on the same screen.

## Install on a machine

```sh
config/orca-fork/agent-computer/agent-computer.sh install   # apt packages, service, MCP registration
~/.local/share/orca-fork/agent-computer/agent-computer.sh status   # URL + password
```

`uninstall` removes the service and the MCP registration. `ORCA_COMPUTER_DISPLAY`,
`ORCA_COMPUTER_WEB_PORT` and `ORCA_COMPUTER_GEOMETRY` change the defaults at install time.

## Open it in Orca

On the Mac, with the VPS connected in Orca: right sidebar → **Ports** → port **6080** (detected) →
Forward → **Open in browser** (Orca's browser pane), then open
`http://localhost:6080/vnc.html?autoconnect=1&resize=remote` and enter the password from `status`.
Live screen, mouse, keyboard and clipboard (noVNC side panel). Without Orca:
`ssh -N -L 6080:127.0.0.1:6080 ubuntu@<vps>`.

## Next

- A dedicated **Computer** pane (noVNC embedded, watch / take control) opened from the machine's group,
  streaming RFB over the paired server connection instead of a forwarded port.
- Control handoff (one controller at a time; agents told when the owner takes over).

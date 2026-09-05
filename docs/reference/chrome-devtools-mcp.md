# Chrome DevTools MCP for Codex and OpenCode

Orca can explicitly configure Chrome DevTools MCP for Codex and OpenCode v1. This
connects an agent to Chrome running on the same execution host using `--autoConnect`.
It is separate from Orca's embedded browser commands.

## Setup

Install the agent CLI and a Node.js LTS version supported by Chrome DevTools MCP,
plus npm, on the execution host. Auto-connect requires Chrome 144 or newer. The Codex CLI must be installed even for its configuration
status check.

Preview the canonical global config changes, then apply them:

```sh
orca agent chrome-devtools setup --agent all --dry-run
orca agent chrome-devtools setup --agent all
orca agent chrome-devtools status --agent all --json
```

Use `--agent codex` or `--agent opencode` to configure only that client. Setup does
not download packages or launch Chrome. The agent starts `npx -y
chrome-devtools-mcp@latest --autoConnect --no-usage-statistics` when it next loads
MCP servers; that first start may download the package from npm. On Windows the
configured command uses the documented `cmd /c npx` wrapper. The MCP startup timeout
is 60 seconds. Usage statistics are disabled by the installed command.

Open `chrome://inspect/#remote-debugging` in Chrome and enable remote debugging
manually. Restart the agent session so it reloads MCP configuration, and allow
Chrome's connection prompt when the agent first uses a browser tool. Setup never
changes Chrome flags, restarts the browser, or grants that connection permission.

## Which configuration is changed

- **Codex:** `~/.codex/config.toml`. Orca mirrors this canonical file into its
  account homes, so writing only the active managed `CODEX_HOME` can be overwritten
  at the next sync. The setup command deliberately ignores `CODEX_HOME` and
  `ORCA_CODEX_HOME` as destinations. It copies only the canonical config to a
  temporary directory and uses `codex mcp list --json` to validate it before and
  after adding the server; authentication files are not copied.
- **OpenCode v1:** `$XDG_CONFIG_HOME/opencode/opencode.json`, falling back to
  `~/.config/opencode/opencode.json`, or the existing `opencode.jsonc` in that
  directory. Comments and unrelated settings are preserved. If both files exist,
  setup asks you to resolve the ambiguity. Orca's `OPENCODE_CONFIG_DIR` is a managed
  overlay, not the destination. Explicit `OPENCODE_CONFIG` or
  `OPENCODE_CONFIG_CONTENT` overrides must be unset before global setup. OpenCode
  v2's `mcp.servers` layout and unknown schemas are rejected.

Setup preflights both clients before publishing either file when `--agent all` is
used. An existing compatible entry is left unchanged. Conflicting or disabled
entries fail with the path to review; setup never silently replaces an existing
server. Codex configurations that cannot accept an appended TOML table also fail
validation without changing the original file. Existing changed files receive a
unique `.orca-chrome-devtools-<id>.bak` backup beside the original. Output names the
backup. Repeated setup does not create another backup when nothing changes.

A filesystem failure during publication can leave the first client configured and
the second unchanged. The error lists files already applied and the backup naming
pattern. Review those files before retrying; setup does not roll back concurrent
user edits. To undo installation, remove just the `chrome-devtools` entry from the
canonical config, or restore the reported backup after checking for later edits,
and restart the agent session.

## Execution host and verification

Run this command directly on the host where the agent process runs. It works
outside a Git repository and in folder workspaces. It rejects remote routing
selectors (`--host`, `--environment`, `--pairing-code`) and forwarded Orca contexts
rather than writing a different host's config. A native SSH shell or WSL terminal
can configure its own host, but `--autoConnect` there does not connect to desktop
Chrome on another host or the Windows host. For that arrangement, follow the
upstream remote-browser documentation and configure the endpoint separately.

`status` and `--dry-run` check canonical configuration only. They report
`configured` or `missing`, fail on conflicts, and explicitly mark the MCP handshake
and browser connection as `not-checked`. `configured` does not mean a running
session has loaded tools: project configuration, managed overlays, missing Node/npm,
or Chrome's permission prompt may still affect the session. After restarting,
verify the MCP server in the agent and ask it to list pages. A missing
`DevToolsActivePort` usually means Chrome's remote debugging option is not enabled
on the host where the MCP process runs.

## Upstream references

- [Chrome DevTools MCP client configuration](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/client-configurations.md)
- [Chrome auto-connect setup](https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect)
- [Chrome DevTools MCP prerequisites and remote browser options](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [OpenCode MCP servers](https://opencode.ai/docs/mcp-servers/)
- [OpenCode configuration precedence](https://opencode.ai/docs/config/)

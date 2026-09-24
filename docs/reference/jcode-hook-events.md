# jcode hook events

What jcode actually emits, and why Orca's status mapping is shaped the way it is.
Everything below was captured from jcode **v0.87.1 (944f747e9)** by pointing every
`[hooks]` entry in `config.toml` at a script that appends `$JCODE_HOOK_PAYLOAD` to
a log, then running real turns. Re-capture before changing the mapping; do not
edit it from memory.

## The six events

jcode's `[hooks]` table (`crates/jcode-base/src/hooks.rs`) has six lifecycle
points. Five are **observers** — detached, fire-and-forget, they can never slow
the agent. One, `pre_tool`, is a **gate**: jcode spawns it, writes the tool input
to its stdin, and waits for it to exit before the tool runs.

| Event           | When                                         | Orca state | Notable payload fields                                    |
| --------------- | -------------------------------------------- | ---------- | --------------------------------------------------------- |
| `session_start` | TUI open, attach, or `--resume`               | none       | `source` = `create`/`attach`/`resume`, `model`             |
| `turn_start`    | prompt submitted, before the model generates  | `working`  | `source`, `model`                                          |
| `pre_tool`      | before each tool call (gate)                  | `working`  | `tool_name`, `tool_input` (argument JSON as a string)      |
| `post_tool`     | after each tool call                          | `working`  | `tool_name`, `status`, `duration_ms`, `output_bytes`/`error` |
| `turn_end`      | turn finished                                 | `done`     | `status`, `duration_ms`, `model`, `last_assistant_text`, `error` |
| `session_end`   | session closed                                | `done`     | `source` = `close`                                         |

`session_start` is identity-only. jcode fires it on an idle TUI open, so mapping
it to `working` would spin before the user has typed anything (same reason Devin
does not map its `SessionStart`).

## Captured payloads

A `jcode run` turn that read one file and wrote another:

```json
{"cwd":"/private/tmp/jcode-work","event":"session_start","model":"claude-haiku-4-5","session_id":"session_pawprint_1790149117838_071c2a106812396c","source":"create"}
{"cwd":"/private/tmp/jcode-work","event":"pre_tool","session_id":"session_pawprint_…","tool_input":"{\"file_path\":\"sample.txt\",\"intent\":\"Read sample.txt to get its contents\"}","tool_name":"read"}
{"cwd":"/private/tmp/jcode-work","duration_ms":"0","event":"post_tool","output_bytes":"12","session_id":"session_pawprint_…","status":"ok","tool_name":"read"}
{"cwd":"/private/tmp/jcode-work","event":"pre_tool","session_id":"session_pawprint_…","tool_input":"{\"content\":\"HELLO\",\"file_path\":\"out.txt\",\"intent\":\"Write uppercased contents of sample.txt to out.txt\"}","tool_name":"write"}
{"cwd":"/private/tmp/jcode-work","duration_ms":"9","event":"post_tool","output_bytes":"137","session_id":"session_pawprint_…","status":"ok","tool_name":"write"}
```

A TUI turn that failed upstream (note `turn_start`, which the `run` path does not emit):

```json
{"cwd":"/private/tmp/jcode-work","event":"session_start","model":"claude-opus-5","session_id":"session_snail_…","source":"create"}
{"cwd":"/private/tmp/jcode-work","event":"turn_start","model":"claude-opus-5","session_id":"session_snail_…","source":"chat"}
{"cwd":"/private/tmp/jcode-work","duration_ms":"6868","error":"Anthropic API error (503 Service Unavailable): …","event":"turn_end","model":"claude-opus-5","session_id":"session_snail_…","status":"error"}
```

Three consequences the mapping depends on:

- **`turn_start` only fires on the streaming turn path** (TUI, desktop, swarm
  workers, headless sessions), not `jcode run`. It is what fills the otherwise
  blank window between a submitted prompt and the first tool call.
- **Only `pre_tool` carries `tool_input`.** `post_tool` reports the name and the
  outcome, so the tool preview has to be held from the matching `pre_tool`.
- **Every jcode tool schema has an `intent` string** the model fills in. It is
  the preview fallback when no tool-specific key (`file_path`, `command`, …)
  matches.

## Why Orca subscribes to the gate

`pre_tool` is the only event that can report a tool *while it runs*. Without it a
three-minute `bash` shows no tool at all until it finishes. Two rules keep the
gate from ever costing the agent anything:

1. **The POST is detached.** jcode calls `child.wait_with_output()`, which waits
   for the process *and* reads its stderr to EOF — a backgrounded child that
   inherited stderr would hold the gate open for as long as it ran. The managed
   script runs the POST as `orca_post_jcode_event >/dev/null 2>&1 &`, so the
   inherited pipes are closed and the script exits immediately.
2. **stdin is drained first.** jcode `write_all`s the full tool input to the
   hook's stdin. A tool input larger than the pipe buffer (a big `write`) would
   block that write until the gate timed out if nobody read it, so the script
   drains stdin before any exit path.

Orca never blocks a jcode tool call: the script always exits 0.

## Questions and permissions

jcode has **no interactive per-tool approval prompt**. Its safety model
(`crates/jcode-app-core/src/tool/bash_destructive_gate.rs`) either denies a
command outright or asks the model to justify it — both inside the tool, with no
human in the loop. There is therefore no hook, and no terminal-title state, for
"jcode is waiting on you" during ordinary tool use.

The one tool a *human* answers is ambient mode's `request_permission`
(`crates/jcode-app-core/src/tool/ambient.rs`), resolved out of band with
`jcode permissions`. Orca maps a `pre_tool` for it to `waiting` and publishes the
tool input as the question card. `post_tool` for the same tool is *not* mapped —
by then the human has already answered.

Matching is by exact tool name. jcode's live tool set is `agentgrep, apply_patch,
bash, batch, bg, browser, compile_remote, conversation_search, edit, gmail,
integration_tools, ls, macos_computer_use, maintainer_feedback, mcp, memory,
multiedit, open, panel, patch, read, schedule, session_search, side_panel,
skill_manage, swarm, todo, webfetch, websearch, write` plus the ambient tools;
a substring rule over that set would be matching on coincidence.

## Terminal titles

jcode paints OSC 0 titles roughly once a second. Captured sequence from one TUI
session:

```
jcode → 🐍 jcode Snake → 🐍 jcode/creek Snake → 🌐 jcode Snake · work ~0s → … → 🌐 jcode Snake · last ~6s
```

The format is `<emoji> jcode <session-name>[ · +N -M][ · work|last ~<duration>]`
(`crates/jcode-tui/src/tui/app/terminal_title.rs`). Orca uses it for tab-bar
identity only — status comes from hooks, never from a parsed title. Note there is
no "needs input" title state; that is the same gap as above, not an omission in
the parser.

## Per-pane daemons

jcode runs one server/client daemon per runtime dir, and lifecycle hooks fire
*inside the daemon*. Every TUI client connects the daemon the first pane started,
so without isolation a second jcode pane's events carry the first pane's
`ORCA_PANE_KEY` and its status lands on the wrong tab.

jcode does forward a client's terminal identity to hooks
(`CLIENT_TERMINAL_ENV_VARS` in `crates/jcode-terminal-launch/src/lib.rs`), but
that allowlist covers tmux/zellij/herdr and the terminal emulators — not
`ORCA_PANE_KEY`. Until it does, Orca stamps a per-pane `JCODE_RUNTIME_DIR` so
each pane gets its own daemon, socket, and lock. The value is a 16-hex hash of
the pane key because the socket path is capped at `SUN_LEN` (104 bytes) and a
full pane key never fits.

## Config shape

`[hooks]` values accept a string or an array of strings (`HookCommands` in
`crates/jcode-config-types/src/lib.rs`), and jcode re-reads the config on reload,
so hooks can be added without restarting. jcode parses a hook command line
shell-style but **executes it directly, not through a shell** — the managed value
must be the script path, never an `if [ -f … ]` wrapper.

That shell-style parse is `parse_hook_command`
(`crates/jcode-terminal-launch/src/lib.rs`), and it is why Orca stores the path
**shell-quoted**. The tokenizer splits on unquoted whitespace and consumes every
unquoted backslash as an escape, so a bare Windows path reaches `exec` as
`C:Usersme.orcaagent-hooksjcode-hook.cmd` and no hook fires at all; a POSIX home
with a space splits into two arguments. Single quotes pass a path through
verbatim — backslashes are literal inside them — so Orca single-quotes by
default and falls back to double quotes (escaping `\` and `"`) only for a path
that itself contains a single quote. The value is then TOML-quoted on the way
into the file, so neither the raw path nor the shell-quoted string appears
alone.

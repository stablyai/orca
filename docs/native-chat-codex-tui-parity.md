# Native Chat Codex TUI Parity

This note maps Codex TUI behavior to Orca native chat on branch
`inspect/pr-5824-native-chat`. It is intentionally concrete: the current Orca
surface is a PTY harness around the running TUI, while real native parity should
move selected paths to Codex app-server protocol v2.

## Source Map

- Codex TUI composer: `/Users/jinwoohong/stably/codex/codex-rs/tui/src/bottom_pane/chat_composer.rs`
- Slash command parsing and popup:
  `/Users/jinwoohong/stably/codex/codex-rs/tui/src/bottom_pane/prompt_args.rs`,
  `/Users/jinwoohong/stably/codex/codex-rs/tui/src/bottom_pane/slash_commands.rs`,
  `/Users/jinwoohong/stably/codex/codex-rs/tui/src/slash_command.rs`,
  `/Users/jinwoohong/stably/codex/codex-rs/tui/src/chatwidget/slash_dispatch.rs`
- Skills and mentions:
  `/Users/jinwoohong/stably/codex/codex-rs/tui/src/bottom_pane/skill_popup.rs`,
  `/Users/jinwoohong/stably/codex/codex-rs/tui/src/skills_helpers.rs`,
  `/Users/jinwoohong/stably/codex/codex-rs/core-skills/src/loader.rs`,
  `/Users/jinwoohong/stably/codex/codex-rs/core-skills/src/root_loader.rs`,
  `/Users/jinwoohong/stably/codex/codex-rs/core-skills/src/injection.rs`
- Structured input and native protocol:
  `/Users/jinwoohong/stably/codex/codex-rs/protocol/src/user_input.rs`,
  `/Users/jinwoohong/stably/codex/codex-rs/app-server-protocol/src/protocol/v2/turn.rs`,
  `/Users/jinwoohong/stably/codex/codex-rs/app-server-protocol/src/protocol/common.rs`

## Current Orca Architecture

Orca native chat currently sends through the hosted terminal PTY. The composer
builds paste bytes, writes them through `sendRuntimePtyInput`, then sends a
delayed Enter. This preserves local and SSH behavior because it uses the same
runtime path as terminal typing.

That architecture is useful for incremental adoption, but it means native chat
does not own Codex state. It cannot directly set model, reasoning, permissions,
skills, or session lifecycle. It can only type commands into the TUI and observe
agent hooks/transcripts after the fact.

## Slash Commands

Codex behavior:

- The parser accepts a first-line command of `/name <rest>`.
- The slash popup uses Codex's `SlashCommand` enum order as presentation order.
- Enter on a selected popup row dispatches the command. Tab completes it into
  the draft.
- Some commands accept inline args: `review`, `rename`, `plan`, `goal`, `ide`,
  `keymap`, `mcp`, `raw`, `usage`, `pets`, `side`, `resume`, and
  `sandbox-add-read-dir`.
- Commands are control actions, not ordinary user chat turns. For example
  `/clear` sends `AppEvent::ClearUi`; `/compact` starts compaction; `/model`
  opens the model picker; `/skills` opens skill management.

Current Orca behavior:

- Slash commands are still typed into the TUI over PTY.
- Native optimistic chat bubbles are suppressed for slash drafts so `/clear`
  does not render as a fake queued user message.
- The Codex slash catalog now mirrors the visible TUI command list much more
  closely, but it is still a copied catalog, not a live TUI query.

Recommended route:

- Short term: keep PTY dispatch for slash commands, but treat them as command
  submissions. No optimistic chat bubbles. Enter dispatches; Tab completes.
- Medium term: route commands with app-server equivalents directly. Examples:
  `thread/compact/start`, `thread/list`, `thread/archive`, `thread/delete`,
  `model/list`, permissions/config reads and writes, `skills/list`.
- Long term: stop maintaining a renderer-side Codex command catalog. Either ask
  Codex for the command inventory or host the Codex composer state machine.

## Skills And `$`

Codex behavior:

- `$` opens the skill popup. Rows show display name, description, category tags,
  selection state, filtering, sorting, and scrolling.
- Codex discovers skills from repo, user, system, admin, and plugin roots. Repo
  scope sorts before user/system/admin. Exact duplicate paths are deduped.
- Skill selection is structured. `UserInput` has `Skill { name, path }`, and
  app-server protocol v2 mirrors it. Text `$skill` mentions are only the
  fallback path and must be unambiguous.
- Skill injection reads the selected `SKILL.md` by path, records telemetry, and
  avoids double-injecting already provided host skill prompts.

Current Orca behavior:

- Native chat discovers skills through Orca's skills IPC with the active
  terminal tab's cwd. This is important for worktree symlinks like
  `.agents/skills`.
- `$` autocomplete inserts plain `$skillName` text. That can work through the
  TUI's text fallback, but it is not equivalent to structured
  `UserInput::Skill { name, path }`.

Recommended route:

- PTY mode: keep `$skill` text insertion, but preserve Codex-like filtering,
  scrolling, dedupe, and active-cwd discovery.
- Native mode: retain the selected skill's path and submit
  `UserInput::Skill { name, path }` through app-server `turn` input. This avoids
  ambiguity when multiple skills share a name and lets Codex inject the exact
  file the user selected.

## Files, Mentions, And Images

Codex behavior:

- User input supports `Text` with text elements, `Image`, `LocalImage`,
  `Skill`, and `Mention`.
- The TUI has file search/mentions and image placeholders. Large pastes become
  placeholders so text element ranges stay aligned.
- Remote image rows are first-class composer attachments and can be removed with
  keyboard navigation.

Current Orca behavior:

- File attach inserts a path/reference into the draft and relies on the TUI to
  interpret it.
- Image paste saves a temp file, then inserts the agent-specific reference.
- Local attachments are blocked for remote sessions because the local path may
  not exist on the SSH target.

Recommended route:

- PTY mode: keep conservative path insertion and remote-session blocking.
- Native mode: send structured `LocalImage` or `Image` input through Codex
  protocol and use remote runtime file transfer semantics for SSH.

## Model, Reasoning, Permissions

Codex behavior:

- `/model`, `/permissions`, `/keymap`, `/vim`, `/experimental`, and related
  commands are stateful TUI/app-server surfaces.
- App-server v2 already exposes model listing, config requirements, approval
  policies, permission profiles, and reasoning effort fields.

Current Orca behavior:

- Native chat does not know or set Codex model/reasoning directly. Typing
  `/model` opens Codex's TUI picker.
- Earlier UI controls for model/thinking were removed because they were not
  wired to real Codex state.

Recommended route:

- Do not re-add model or reasoning dropdowns until they read from and write to
  Codex app-server state.
- In PTY mode, expose `/model` as a command shortcut only.

## Approvals, Elicitations, And Tool UI

Codex behavior:

- Approval overlays cover exec approval, permission approval, file change
  approval, network approval, MCP elicitation, and request-user-input forms.
- App-server notifications include thread status, waiting-on-approval/user-input
  flags, item start/completion, diff/plan updates, and skill changes.

Current Orca behavior:

- Native chat has interactive cards sourced from Orca's existing agent status
  hooks. This is good for common question/approval flows, but it is not the full
  Codex approval overlay model.

Recommended route:

- Keep PTY fallback for anything not represented in Orca hooks.
- For Codex-native mode, subscribe to app-server notifications and render
  approvals/tool calls from protocol events rather than scraping terminal text.

## Session And History

Codex behavior:

- `/new`, `/resume`, `/fork`, `/archive`, `/delete`, `/compact`, and `/clear`
  are session lifecycle commands.
- The composer has local and persistent history; Up/Down recall, Ctrl+R reverse
  search, Esc edit/interrupt behavior, Ctrl+J newline, Ctrl+T transcript, and
  Ctrl+C quit/interrupt behavior.

Current Orca behavior:

- Native chat has small in-memory draft history and Enter/Shift+Enter.
- Session commands are typed into the hosted TUI.

Recommended route:

- Short term: keep TUI command dispatch and avoid fake optimistic bubbles for
  lifecycle commands.
- Native mode: use app-server thread APIs for lifecycle and expose real thread
  transitions in the Orca UI.

## Priority

1. Fix PTY-command correctness: Enter dispatches slash commands, Tab completes,
   slash commands never render as queued chat turns, interrupt clears working UI.
2. Make `$` skill popup match Codex basics: active cwd, dedupe, scrolling,
   filtering, source labels, and no product-specific hardcoding.
3. Keep fake model/thinking controls out until backed by Codex app-server state.
4. Add an app-server integration spike for Codex native mode: `skills/list`,
   structured `UserInput::Skill`, model list/settings, and thread lifecycle.
5. Move approvals/tool rendering from hook approximations to protocol events.

## Test Targets

- `/clear` from native slash popup dispatches immediately and produces no
  pending user bubble.
- `/compact`, `/model`, `/skills`, `/resume`, `/diff`, `/status`, and unknown
  slash commands behave like the hosted TUI.
- `$ref-oss` appears exactly once when the worktree has `.agents/skills` as a
  symlink.
- Down-arrow in `$` suggestions scrolls the popup window.
- Interrupt during work returns the composer from Stop to Send after the agent
  status settles.
- SSH sessions never insert local-only attachment paths as if they were remote
  files.

# Agent permission presets

Orca's permission presets map one product choice onto agent-specific CLI arguments or
environment variables. The word **Auto** does not describe one uniform security policy:
depending on the agent, it can mean classifier-reviewed actions, edits-only approval,
risk-threshold approval, or a sandboxed approval reviewer. Keep the exact behavior visible in
the UI and do not imply that every agent provides the same safety boundary.

This matrix records vendor-documented presets checked on September 6, 2026. A local help
check identifies the syntax accepted by the installed CLI; the linked vendor source defines
its semantics.

| Agent | Auto preset | Verified behavior | Evidence |
| --- | --- | --- | --- |
| Claude Code | `--permission-mode auto` | Uses Claude's auto-mode permission classifier. The installed Claude Code 2.1.263 help lists `auto` separately from `acceptEdits`, `manual`, and `bypassPermissions`. | [Claude Code permissions](https://code.claude.com/docs/en/permissions) and `claude --help` |
| Codex | `--approve-for-me` | Routes approval requests through automatic review while retaining the workspace-write sandbox. The installed Codex CLI 0.153.4 help documents this behavior. | [Codex security](https://developers.openai.com/codex/security/) and [Codex CLI argument tests](https://github.com/openai/codex/blob/main/codex-rs/cli/src/main.rs) |
| Gemini CLI | `--approval-mode auto_edit` | Auto-approves edit tools while continuing to prompt for other tools. The installed Gemini CLI 0.58.0 help lists `default`, `auto_edit`, `yolo`, and `plan`. | [Gemini CLI repository](https://github.com/google-gemini/gemini-cli) and `gemini --help` |
| goose | `GOOSE_MODE=smart_approve` | Automatically approves low-risk actions and asks for approval on higher-risk actions. | [goose permission modes](https://github.com/block/goose/blob/main/documentation/docs/guides/managing-tools/goose-permissions.md) and [mode values](https://github.com/block/goose/blob/main/crates/goose-provider-types/src/goose_mode.rs) |
| Qwen Code | `--approval-mode auto` | Uses an LLM classifier for shell commands, network calls, and out-of-workspace edits; risky or uncertain actions still prompt. | [Qwen Code approval modes](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/approval-mode.md) |
| Devin CLI | `--permission-mode smart` | Auto-approves workspace edits and uses a fast model to judge other actions, falling back to a prompt when unsafe, uncertain, or unavailable. Smart is rolling out gradually and may be unavailable for some accounts. | [Devin permissions](https://docs.devin.ai/cli/reference/permissions.md) and [commands and flags](https://docs.devin.ai/cli/reference/commands.md) |
| Droid | `--auto medium` | Auto-approves edits, low-risk tools, and reversible workspace changes such as installs, builds, local commits, moves, and copies. Higher-risk actions still prompt. | [Droid autonomy levels](https://docs.factory.ai/autonomy-and-safety/auto-run.md) and `droid --help` from Droid 0.205.0 |

Gemini's `auto_edit` is deliberately narrower than classifier-based Auto modes. Droid also
offers `--auto low` and `--auto high`; Medium is the balanced candidate because Low covers
edits and low-risk tools, while High permits high-risk actions unless a separate safety check
intervenes. Devin's `accept-edits` is a narrower fallback if Smart is unavailable, but it is
not behaviorally equivalent to Smart.

Claude Agent Teams forwards its arguments to the Claude binary through `orca claude-teams`
and uses the same `--permission-mode auto` preset (see `src/cli/handlers/core.ts`).

The global Auto preset uses Manual for harnesses without a verified mapping. Per-agent
controls omit Auto for those harnesses. Custom argument and environment profiles are preserved.
Settings apply to future launches, including folder workspaces and SSH/WSL execution hosts.
The installed CLI and account must support the selected mode; Orca never retries with bypass
when a guarded mode is rejected. Existing default permission preferences are unchanged.

## No verified Auto preset yet

The remaining agents in `YOLO_TUI_AGENT_ARGS` have no intermediate preset verified for this
work: OpenClaude, Antigravity, Aider, Amp, Kiro, Crush, Autohand, Cline,
Command Code, Continue, Cursor, Kimi, Mistral Vibe, Rovo, Hermes, Copilot, Grok, Ante, and Trae.
This means only that this review did not find sufficiently clear vendor evidence for a preset;
it is not a claim that the agent lacks intermediate permission controls. Amp's `smart` agent
mode, for example, controls its model, system prompt, and tool selection rather than command
approval policy, so it must not be treated as an Auto permission preset.

Re-check vendor documentation and current `--help` output before adding any of these agents.
CLI flags and rollout availability change independently of Orca releases.

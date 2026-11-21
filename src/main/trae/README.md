# TRAE CLI Chat

TRAE CLI can run in Orca's native Chat interface through ACP, including existing CLI conversations discovered in AI Vault.

## Requirements

- TRAE CLI 0.216.0 or later, available as `traecli` on the execution host.
- An authenticated TRAE CLI account on that host.
- Each host uses its own CLI installation, account, and conversation store.

Orca launches `traecli acp serve`. The CLI home follows `TRAECLI_HOME`, otherwise `<TRAE_HOME>/cli`, with `TRAE_HOME` defaulting to `~/.trae`.

## Supported behavior

- Native Chat messages, tool calls, permission requests, and asynchronous question forms.
- Model selection preserves the CLI's complete model identifiers, including effort variants.
- Chat permission modes map to TRAE's `default`, `auto`, and `bypass_permissions` modes.
- Standing workspace instructions are appended through ACP's `systemPrompt` session parameter.
- Existing CLI conversations can be adopted into Chat, including segmented fork history and rollback handling.
- Imported user and assistant messages retain their text. Historical tool output is summarized; the original CLI logs retain those details.
- AIR `asyncTasks` notifications keep autonomous turns visible as active agent work after an interactive prompt returns. Terminal tasks use the same task lifecycle records.
- An explicit ACP busy refusal is retried with an abortable backoff. Other failures are returned without resending the prompt.

## Maintenance

The launch adapter and history conversion live in `src/main/trae/`; the TRAE ACP dialect and asynchronous task mapping live in `src/main/acp/acp-dialects/`.

Existing regression coverage is in `acp-structured-trae.test.ts`, `trae-imported-history.test.ts`, and `journal-codex-history.test.ts`. Follow the repository's changed-file gate before publishing changes.

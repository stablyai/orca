# Antigravity terminal-backed Chat UI

Antigravity uses the existing experimental Chat UI over its terminal and saved
transcript. It is not a structured-session provider. The opt-in default-chat
setting applies, and users can return to the terminal.

## Transcript contract

The execution host reads
`.gemini/antigravity-cli/brain/<conversation-id>/.system_generated/logs/transcript.jsonl`.
A hook-reported transcript path takes precedence. Existing WSL exact-path and
host-isolation rules apply; a missing guest transcript must not fall back to a
native host's same-named conversation. Direct SSH panes stay in the terminal:
that connection has no native-chat transcript transport, and its absolute file
path must never be opened on the client. Paired runtimes remain eligible because
their own host reads the transcript. Direct SSH chat support remains unfinished.

The sanitized fixture in `src/main/native-chat/__fixtures__/antigravity/` records
these observed shapes:

- User input is `USER_EXPLICIT/USER_INPUT` with a `USER_REQUEST` wrapper.
- Planner responses carry text, thinking, or tool calls. Tool arguments are in `args`.
- Tool output is a `MODEL` record with a tool-specific type such as `RUN_COMMAND`
  or `VIEW_FILE`. It is not a `TOOL_RESULT` record.
- A planner step marked `DONE` can precede more tool work in the same user turn.
  The decoder therefore emits no turn-completion verdict. The existing host-owned
  hook/status system remains authoritative.

Full reads, incremental tails, and legacy journal imports reuse the same decoder.
Unknown record types are skipped. Tool failures retain a nonzero exit code or
`ERROR` status as an error result.

## Mixed versions

New hosts advertise `native-chat.antigravity.v1`. A new client's chat transport
checks the owning host before reading or subscribing to Antigravity. An older
host gets the existing update-runtime error; a failed capability probe gets the
existing read error. Neither becomes a perpetual first-transcript wait.
No stream opcode or message-block type was added.

## Verification limits

On macOS with installed agy 1.2.7, a resumed test conversation rendered from its
real saved transcript, and a message submitted in the chat composer appeared in
that transcript. Generation returned `401 ACCESS_TOKEN_TYPE_UNSUPPORTED`.
Hooks were disabled in the isolated app profile, so pane/session metadata was
supplied as a fixture; this did not validate actual hook delivery or live status
transitions. Tool rendering was checked separately with the sanitized fixture.

Five bounded real transcript samples supplied 309 tool/activity records; the
corrected decoder preserved all 309. This is offline format evidence, not proof
of a successful new model turn. Windows, Linux, WSL, SSH, paired-runtime execution,
permission questions, and successful tool-generating turns still need live QA.

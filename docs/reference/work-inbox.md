# Work Inbox

Work Inbox collects questions explicitly sent through `orca inbox ask` or `orca inbox mcp`. The desktop sidebar opens the selected execution host's queue, with project and agent filters, unanswered questions, and history. It does not intercept provider-native permission dialogs or automatically configure agents.

## User actions

- Answer with an option, free text, or both. Failed submissions retain the draft and request ID.
- Close with X without answering. The question moves to history; its caller receives `answer: null`, `cancelled: true`, and an explicit message that closure is not approval.
- Reopen a closed question from history, preserving its ID. Old revisions cannot close or answer the new opening.
- Saving an answer and receiving it are separate states. An explicit asker acknowledgement marks an answer received.

## Authority and contract

`work_inbox_items` in the execution host's orchestration database is authoritative. Renderer state is a host-scoped projection. Remote clients use the existing authenticated RPC transport. Older hosts display an unsupported-feature error rather than writing to a local fallback.

| Entry | Authoritative behavior | Regression coverage |
| --- | --- | --- |
| CLI `inbox ask`, MCP `ask_user` | An immutable request ID creates at most one question per asker | Store request-ID tests; MCP transport tests |
| `workInbox.answer` | Human caller check, validated answer and revision compare-and-set | Store answer/receipt tests; RPC human-only tests |
| `workInbox.cancel`, `workInbox.reopen` | Human caller check; no answer or approval; a stale revision conflicts | Store/RPC closure tests; hidden Electron journey |
| CLI resume, MCP `wait_for_answer` | Read the original durable question after timeout or reconnect | MCP resume test; database reopen test |
| `workInbox.ack` | Original asker handle check; answered becomes delivered | Store receipt test; MCP explicit acknowledgement test |

Host methods are in `src/main/runtime/rpc/methods/work-inbox.ts`; persistence is in `src/main/runtime/work-inbox/`. CLI/MCP entry points are under `src/cli/`. The UI is under `src/renderer/src/components/work-inbox/`. Schemas and results live in `src/shared/work-inbox.ts`; regenerate the shared catalog with `pnpm run generate:rpc-params-catalog`.

MCP is an opt-in stdio server, not an additional network listener. The local CLI remains inside Orca's trusted local runtime boundary: asker handles correlate questions and are not a new authentication credential. Human mutations require a desktop or paired-device caller established by the transport.

Questions are oldest first; history is newest first. Reads are bounded to 200 rows and filter by project/agent. Unknown terminal/session metadata remains unclassified. Concurrent edits compare revisions; answer retries use the same immutable request ID. Timeout and disconnect mean pending or unknown, never approval.

## Persistence and compatibility

The additive schema uses `CREATE TABLE IF NOT EXISTS` without resetting existing tables. Reopening the database retains pending questions and existing data. Older binaries ignore the new table. New RPC methods fail explicitly against unsupported remote hosts. A monotonic closure marker ensures an already-waiting caller observes closure even if the human immediately reopens the item.

## Focused validation

```sh
pnpm test:node src/main/runtime/work-inbox/work-inbox-store.test.ts src/main/runtime/rpc/methods/work-inbox.test.ts src/cli/work-inbox-mcp-tools.test.ts
pnpm tc
ORCA_BACKGROUND_LAUNCH=1 pnpm run test:e2e tests/e2e/work-inbox-close-reopen.spec.ts
pnpm run verify:rpc-params-catalog
pnpm run check:code-quality:changed
```

Use disposable profiles for UI tests. Never point fixtures at an existing user profile. Windows, macOS, Linux, SSH, real provider sessions and mobile UI are separate validation boundaries. Record actual results and untested platforms in the PR; this document does not claim all platforms pass.

## Changes

- Added the explicit question queue, opt-in CLI/MCP entry points, and desktop answer/history view.
- Added close-without-answer and reopen. The initial queue lacked a rendered close action; regression tests cover stale revisions, answer races and immediate reopen notifications.
- Automatic agent routing, docked layout, team startup and updater changes are outside this contribution.

**Review regression:** The closed inbox no longer polls an unused count. An unsupported host stops automatic retries until a new open or explicit refresh. use-work-inbox.test.ts covers both cases; the hidden Electron lifecycle test covers close, reopen, answer and receipt. English fallbacks and the Simplified Chinese catalog now agree.


# Context Handoff

This example requires the native context-handoff change in this branch and Host API 1.1.
The manifest's 1.4.247 engine floor is provisional until the host feature receives a release.
Released hosts without `chat.handoff` cannot run it.

Run `Context: Hand off this chat` when the focused workspace has one local chat.
With several chats, invoke the command with an explicit `sessionId`; the command returns
available IDs instead of guessing. Terminal sessions and remote chats are not supported by
this plugin facade. The underlying conversation-command RPC is execution-host native and
can be used by remote-aware clients that check `agent-session.context-handoff.v1`.

The default handoff saves the last 48,000 characters of text history. It does not call a model
or claim to summarize omitted history. A summary producer can instead call `chat.readContext`
and invoke the command with `{ sessionId, context, cursor, fence }`, retaining the cursor and
fence from that read. Automatic token thresholds and model selection belong in that producer.

Orca checks the cursor before stopping the provider and refuses a stale summary. Existing
active-turn, approval, background-work and unsettled-message protections still apply.
Queued drafts remain preserved and paused by the existing clear behavior.

The clear boundary and context are committed together. The next ordinary send receives:

1. The saved handoff context.
2. The previous session's most recent user message, directly from the journal.
3. The current user message with its original blocks unchanged.

The original send remains unchanged in the journal. A known rejection leaves the context
available for another send; accepted or uncertain delivery consumes it. An uncertain provider
write is never automatically retried. Clear retains the existing transcript divider behavior
and keeps older rows in the journal; it does not open a second tab.

The example persists the operation ID before asking Orca to clear. If the reply is lost,
invoking the command again retries that operation. Unconfirmed or expired operations stay
pending for reconciliation; the plugin must not substitute a fresh operation ID.

The new `chat:read` and `chat:handoff` permissions require consent. Handoff is worker-only.
Every call checks membership of the explicit chat in the focused workspace. Summaries and
message contents are excluded from mutation audit entries.

Adding handoff metadata changes persisted context-boundary records. Older builds may treat
these records as newer data; retain a compatible build when opening chats that used handoff.

## Test

```sh
node --test examples/plugins/context-handoff/main.test.mjs
```

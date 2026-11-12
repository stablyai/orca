# Messaging and gates

Handle a whole `check` batch before the next `check`.

Groups (`@all`, `@idle`, `@codex`, ...) reach the live workers of your Run;
`@worktree:<id>` also reaches coordinators in that workspace. Use groups only
for deliberate fan-out.

To reach an agent on a paired server, use `send --on <server>`; a reply to mail
from another server needs no flag. See
[Placement and remote execution](placement-and-remote.md).

## Selective acknowledgment

After inspecting mail with `check --peek` or `inbox --full`, acknowledge only
explicitly selected messages with:

```text
ORCA orchestration check --terminal <handle> --ack-ids "<msg_id>,<msg_id>" --json
```

This never takes another batch. `markedIds` lists newly handled messages;
`alreadyReadIds` lists selected messages already handled, making retries safe.
Unselected mail, including questions arriving after inspection, stays unread.
Every ID must exist in the caller's current mailbox (direct, bound Run or
Dispatch); an unknown, foreign or legacy ID rejects the entire selection.
Existing consumer/pane fencing still applies. Do not use this to discard mail
the agent has not processed.

Do not combine `--ack-ids` with other read, acknowledgment, formatting or wait
options. Both the CLI and the execution host need selective-ack support; older
hosts are refused before consumption. This applies to remote/SSH hosts too.

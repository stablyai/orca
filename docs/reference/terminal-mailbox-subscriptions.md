# Terminal mailbox subscriptions

A running agent in an Orca terminal can opt into mailbox pointers without joining a
Run or Dispatch:

```sh
orca orchestration subscribe --json
orca orchestration subscription status --json
orca orchestration unsubscribe --json
```

Run these commands inside the receiving agent's Orca-launched environment. The
runtime verifies the existing launch proof, exact pane, process incarnation and
host authority. A terminal handle alone is not authorization. There is no target
selector and no automatic registration. The registration stores only the host
scope, handle, pane, PTY and process incarnation; it does not retain or print the
launch token or an SSH attachment secret. A subscribed receiver gets a pointer for
existing undelivered mail as well as later arrivals; the original message body
stays in the inbox.

Registration is ephemeral and belongs to the execution runtime. Repeating
`subscribe` for the same live identity is idempotent. Runtime restart, process
replacement, PTY exit, handle remint or invalid host authority requires explicit
registration again. A transport outage leaves the subscription and durable mail
intact while status reports `host_unverifiable`; it is not evidence of process
exit. A new client against a host without
`orchestration.terminal-subscription.v1` reports `unsupported` without attempting
registration. Existing Run/Dispatch mail keeps its original delivery path.
The original receiver may still inspect or remove its subscription after ownership
moves to a Run or Dispatch; both actions require the stored exact terminal identity,
so a replacement process cannot manage the prior registration.

The runtime rechecks the full binding before writing a pointer and before
submitting Enter. Auto-Enter requires a positively resolved, unchanged, non-Cursor
agent identity plus a live, writable, settled-idle pane. If the pane becomes
working, permission-blocked, unwritable or identity-ambiguous after the pointer,
the pointer remains for manual submission and a later idle edge does not send
Enter. A sender cannot override these checks. Only the existing runtime PTY writer
performs the write; no provider socket, native queue or `session-peer` installation
is required. Notification results are generation-fenced, so completion of an older
pointer or Enter write cannot overwrite the status of a later re-registration.

`subscription status` describes the latest notification attempt, not message
processing. Its state distinguishes `active`, `blocked_permission`,
`blocked_working`, `ambiguous_write`, `stale_replaced`, `host_unverifiable`,
`proven_exited` and `unsubscribed`. `submitted` means the Enter write was accepted;
`deferred` includes manual submission; `unverifiable` means the current host or a
write result cannot be proved. `messageIds` identifies the attempted batch. The
`submitPolicy` value names the eligibility rule, not the current agent verdict:
`recognized_non_cursor` still requires a positive non-Cursor identity at submission
time, while Cursor and unknown identities remain manual. The
subscribe and unsubscribe receipts support exact `--retry-request` replay. The
existing send receipt, unread/read flags and acknowledgement semantics are
unchanged. Inbox inspection does not acknowledge a message.

Status access itself requires a currently verified exact receiver binding.
`host_unverifiable` and `proven_exited` are retained runtime states and may appear in
a race with a verified request, but a disconnected or exited receiver cannot query
them later without valid current launch authority.

Mutation replay is bound to the verified host, handle, pane, PTY and process
incarnation. Reusing a request ID from another receiver fails as a request mismatch.
A completed replay does not reapply the ephemeral mutation: JSON output returns the
original receipt as `historicalReplay` while the top-level fields report current
read-only status, and human output labels the result as historical. After a runtime
restart, the same distinction applies if the exact process binding survives; a new
process incarnation requires a new request ID and explicit subscription.

After an ambiguous write, inspect the inbox explicitly. The same execution
incarnation must not replay the pointer or Enter. A restart, missing leaf or
transport timeout does not release an attempted reservation. Once the execution
host positively reports a replacement incarnation or exit, the old tuple is
reconciled and a newly registered process can receive a fresh pointer. No message
body is replayed, and no old handle is rebound to a new recipient.

This first version supports bare terminal recipients that the runtime can resolve
through its existing live-leaf delivery path. It does not add background PTY
resolution, restart slept panes, introduce a Codex app-server controller, or migrate
mail between handles. Related work: Orca issues/PRs #18206, #8057, #12033, #18731,
and #18208.

The live provider validation covers Codex and Claude Code. Antigravity CLI 1.2.7 is
outside the v1 automatic-wake scope: after a successful receiver subscription it can
temporarily make the current terminal authority unverifiable. Orca therefore leaves
the mail unread and writes no pointer or Enter. Antigravity sessions should inspect
the inbox explicitly until their authority/readiness lifecycle has a stable native
integration.

# Structured session execution and historical repair

Current execution belongs to the host. A running journal turn is conversation history, not proof of current work. The host combines lease adjudication, process observations, native transport binding, admitted submissions, and provider-sink activity into one execution view. Imported rows do not establish current activity merely because they use the current writer fence.

The view separates execution evidence (`live`, `unverifiable`, `exited`, or no observed owner), activity, and control. An idle native process is not working. A live native orphan has no controllable transport. A live TUI owner does not need a native child; without current activity evidence its activity remains unverifiable. Direct SSH does not gain a local structured-runtime fallback.

## Delivery

The existing ClientDelivery owner publishes lifecycle completion, including committed journal changes followed by failed record cleanup. Its execution publication has a host incarnation, monotonic revision, ownership fence, acquisition generation, and journal dependency cursor. Runtime-only changes do not need a new journal row. Clients revoke controls immediately and join positive claims only to journal state they actually accepted. Stream generations fence old callbacks; reconnect revokes effective controls while retaining history.

The optional `agent-session.execution-view.v1` capability selects current status semantics. Older clients retain the historical status projection. New clients explicitly indicate unavailable verification when an older host supplies no execution metadata. Existing frame types carry optional metadata; no new stream opcode is introduced.

A bounded maintenance pass shares the lease-renewal scheduler. It retries recovery and durable historical receipts with concurrency four, exponential backoff and six attempts per identity. A changed owner/receipt identity or receipt expiry admits another bounded pass. None of these time limits proves process death. Desktop Retry verification uses existing hold/admission and read refresh paths; it does not override ownership checks.

Historical repair is a separate migration with database downgrade costs; see [structured-session-historical-repair.md](./structured-session-historical-repair.md).

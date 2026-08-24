# Cross-plane ACK and completion contract

Status: D1 verified after the 2026-08-25 upstream rebase. This contract verifies evidence; it does
not send, acknowledge, complete, dispatch, or rebind work.

States are monotonic evidence grades:

1. `accepted`: Orca has a stored request. `ok:true`, a message row, or a sequence proves no more.
2. `prompt_delivered`: the stored ACK is in the original thread, has a later sequence, echoes the
   correlation ID, reverses the expected sender/receiver epochs, and is read back from Orca storage.
3. `completion_verified`: `prompt_delivered` plus a stored completion receipt with the same thread and
   correlation ID, and a native Dispatch query returning `completed`.

The evidence contract contains `messageId`, `sequence`, `threadId`, `correlationId`, `senderEpoch`,
`receiverEpoch`, `ackMessageId`, `ackSequence`, `ackReadBack`, and `completionReceiptId`. Missing,
fabricated, stale-epoch, out-of-order, cross-thread, or correlation-mismatched evidence returns a
non-mutating degraded verdict with `effectsApplied=false`.

Orca identity and external-plane identity are never equated. A link must name both identities, the
external plane, `linkedBy=neutral_coordinator`, and a distinct evidence ID. Graphify can project the
verdict and revision read-only; it has no ACK, completion, identity-link, or execution authority.

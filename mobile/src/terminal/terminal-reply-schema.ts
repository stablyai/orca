import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

// Terminal input, the in-place viewport update, the worker-takeover report and the buffer clear.
// Checked against the terminal-send envelope src/main/runtime/rpc/methods/terminal/
// terminal-send-method.ts answers with, `terminal.updateViewport` in terminal-viewport-methods.ts,
// and `orchestration.workerTerminalUserInput` in orchestration/worker/worker-release.ts.

/**
 * Whether the runtime took the bytes of a terminal write.
 *
 * `send.accepted` must be exactly `true` — main's rule, and the one thing every terminal-send call
 * site reads — so a reply without the envelope is "not delivered" rather than an error. Both levels
 * are salvaged optionals because `isTerminalSendResultAccepted` guarded both, and the whole payload
 * reaching `object-result-or-null` means an incompatible reply lands on that policy's `null`, which
 * the five senders already compare against `true`.
 *
 * Owned here rather than in the session domain because terminal is the lower layer: the session
 * screen's native-chat write imports it, not the other way round.
 */
export const terminalSendAcceptedSchema = z
  .looseObject({
    send: salvagedOptional(
      'send',
      z.looseObject({ accepted: salvagedOptional('accepted', z.boolean()) })
    )
  })
  .transform((reply) => reply.send?.accepted === true)

/**
 * What the runtime did with a viewport the refit sent in place.
 *
 * Both members are optional and both project through `=== true`. That is main's reader's rule, not
 * the call site's: main's `terminalViewportUpdateReader` booleanised both members before the refit
 * saw them, so the refit's own reads are plain truthiness — terminal-viewport-refit.ts:154 moves
 * the subscription record on `updated` and :156 reflows local scrollback on `applied`. Keeping the
 * `=== true` here is therefore what holds those two reads where main had them; anything that is not
 * exactly `true` falls through to the legacy resubscribe. The host also answers `seq`, which no
 * caller reads; it passes through the loose object rather than being declared as a requirement with
 * no reader.
 */
export const terminalViewportUpdatedSchema = z
  .looseObject({
    updated: salvagedOptional('updated', z.boolean()),
    applied: salvagedOptional('applied', z.boolean())
  })
  .transform((reply) => ({ updated: reply.updated === true, applied: reply.applied === true }))

/**
 * The two terminal writes whose reply body no call site reads.
 *
 * The worker-takeover report is decided by acceptance alone — worker-terminal-takeover-report.ts:46
 * reads `accepted` and raises a fixed sentence of its own — and the buffer clear reports success on
 * any fulfilled reply. The host does answer `{ changed }` and `{ clear }`; declaring either would be
 * a requirement with no reader behind it.
 */
export const terminalWriteUnreadReplySchema = z.unknown()

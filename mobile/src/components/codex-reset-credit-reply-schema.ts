import { z } from 'zod'
import { salvagedOptional } from '../../../src/shared/zod-salvage'

// The two Codex reset-credit replies. Checked against status.ts's `status.get` handler and
// accounts.consumeCodexResetCredit in src/main/runtime/rpc/methods/accounts.ts.

/**
 * The capability list the reset-credit probe reads off `status.get`.
 *
 * `capabilities` is optional and its elements are strings: codex-reset-credit-capability.ts:22
 * guards with `Array.isArray` before `includes`, so absence has always meant "unsupported", and a
 * list carrying a non-string is dropped whole rather than per element — which is the same answer
 * main gave, because `Array.isArray(...) && includes(...)` never matched a number anyway.
 *
 * The operation's `object-result-or-null` policy turns an unreadable reply into `null` rather than
 * a throw, so a foreign payload still reads as "unsupported" at the probe's own `catch`.
 */
export const codexResetCapabilityListSchema = z
  .looseObject({
    capabilities: salvagedOptional('capabilities', z.array(z.string()))
  })
  .transform((reply) => reply.capabilities)

/**
 * The redeem reply, forwarded whole.
 *
 * `decodeResetResult` (codex-reset-credit.ts:159) is the validator: it refuses a reply whose scope
 * is not the one this attempt claimed, pairs `status`/`outcome`/`retryDisposition` against each
 * other, and raises one sentence the confirm sheet shows. Declaring any of that here would split a
 * single refusal rule across two places and let a reply pass the reader and fail the decoder with a
 * different message. The forward is opaque on purpose, not a member left unchecked.
 */
export const codexResetCreditReplySchema = z.unknown()

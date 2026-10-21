import { z } from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'

// Opening a file from the Changes list. Neither open reply's payload is read: the tab arrives over
// the session stream, and the caller only needs to know the host accepted. `z.unknown()` is the
// honest schema for a payload with no reader, not a holdout.
const unreadPayload = z.unknown()

export const sourceFileDiffOpenRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.open-diff-tab',
    method: 'files.openDiff',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('diff-tab-opened', unreadPayload)
  })
)

/** The fallback when a host is too old to offer a diff tab. */
export const sourceFileOpenRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.open-edit-tab',
    method: 'files.open',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('edit-tab-opened', unreadPayload)
  })
)

/**
 * One candidate tab from `session.tabs.list`.
 *
 * `id` and `type` are required because the reveal filters on `tab.type` and returns the candidate
 * by identity (reveal-mobile-source-control-session-diff.ts:70). `mode`, `relativePath` and
 * `diffSource` stay `unknown`: :72-81 compares each to a literal or to null, so a host that sends
 * a shape mobile does not recognise must simply not match, never fail the list.
 */
const sessionFileTabSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  mode: z.unknown().optional(),
  relativePath: z.unknown().optional(),
  diffSource: z.unknown().optional()
})

export type MobileSessionFileTabCandidate = z.output<typeof sessionFileTabSchema>

/**
 * The reveal polls this list, so an unreadable reply must read as "not yet", not as a failure:
 * :64 treats a null value exactly like a refusal and polls again. `.catch(null)` keeps that,
 * and it is also what main did — one bad tab in the array made the whole list null.
 */
const sessionFileTabListSchema: z.ZodType<
  { tabs: MobileSessionFileTabCandidate[] } | null,
  unknown
> = z
  .object({ tabs: z.array(sessionFileTabSchema) })

  .transform((value) => ({ tabs: value.tabs }))
  .nullable()
  .catch(null)

/** A refused list means poll again, so refusal is a skip rather than the end of the reveal. */
export const sessionFileTabListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'session.file-tab-list-or-skip',
    method: 'session.tabs.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('session-file-tabs', sessionFileTabListSchema)
  })
)

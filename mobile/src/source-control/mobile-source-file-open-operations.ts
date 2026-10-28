import { z } from 'zod'
import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'

// Tabs arrive through the session stream; open callers consume only acceptance, so leave payloads unconstrained.
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

export const sourceFileOpenRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.open-edit-tab',
    method: 'files.open',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('edit-tab-opened', unreadPayload)
  })
)

// Require tab id/type for reveal; compare unknown mode/path/source values without rejecting the list.
const sessionFileTabSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  mode: z.unknown().optional(),
  relativePath: z.unknown().optional(),
  diffSource: z.unknown().optional()
})

export type MobileSessionFileTabCandidate = z.output<typeof sessionFileTabSchema>

// Unreadable lists mean not yet: preserve null so reveal keeps polling instead of failing.
const sessionFileTabListSchema: z.ZodType<
  { tabs: MobileSessionFileTabCandidate[] } | null,
  unknown
> = z
  .object({ tabs: z.array(sessionFileTabSchema) })

  .transform((value) => ({ tabs: value.tabs }))
  .nullable()
  .catch(null)

export const sessionFileTabListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'session.file-tab-list-or-skip',
    method: 'session.tabs.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('session-file-tabs', sessionFileTabListSchema)
  })
)

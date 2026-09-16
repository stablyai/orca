import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import type { RpcCompatibleReader } from '../transport/rpc-operation-contract'
import { rpcUncheckedPayloadReader } from '../transport/rpc-reader-payload'

// Opening a file from the Changes list. Neither reply's payload is read: the tab arrives over the
// session stream, and the caller only needs to know the host accepted.

export const sourceFileDiffOpenRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.open-diff-tab',
    method: 'files.openDiff',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('diff-tab-opened')
  })
)

/** The fallback when a host is too old to offer a diff tab. */
export const sourceFileOpenRun = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.open-edit-tab',
    method: 'files.open',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcUncheckedPayloadReader('edit-tab-opened')
  })
)

export type MobileSessionFileTabCandidate = {
  readonly id: string
  readonly type: string
  readonly mode?: unknown
  readonly relativePath?: unknown
  readonly diffSource?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isSessionFileTabCandidate(value: unknown): value is MobileSessionFileTabCandidate {
  return isRecord(value) && typeof value.id === 'string' && typeof value.type === 'string'
}

const sessionFileTabsReader: RpcCompatibleReader<
  unknown,
  'session-file-tabs',
  { tabs: MobileSessionFileTabCandidate[] } | null
> = (raw) => ({
  compatible: true,
  variant: 'session-file-tabs',
  value:
    isRecord(raw) && Array.isArray(raw.tabs) && raw.tabs.every(isSessionFileTabCandidate)
      ? { tabs: raw.tabs }
      : null,
  salvage: { droppedPaths: [], droppedCount: 0 }
})

/** A refused list means poll again, so refusal is a skip rather than the end of the reveal. */
export const sessionFileTabListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'session.file-tab-list-or-skip',
    method: 'session.tabs.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: sessionFileTabsReader
  })
)

import type { PtyIncarnationHandleRecord } from '../../orca-runtime-core'
import type { AgentSenderHandleReads } from '../../runtime-agent-sender-associations'
import type { TerminalHandleRecord } from '../../runtime-terminal-contracts'
import type {
  RuntimeLeafRecord,
  RuntimePtyWorktreeRecord
} from '../../runtime-terminal-state-records'

type IssuedHandleSource = {
  leafHandle(leaf: RuntimeLeafRecord): string | undefined
  ptyHandles(): ReadonlyMap<string, string>
  incarnations(): ReadonlyMap<string, PtyIncarnationHandleRecord>
  ptys(): ReadonlyMap<string, RuntimePtyWorktreeRecord>
  handles(): ReadonlyMap<string, TerminalHandleRecord>
  runtimeId(): string
  rendererGraphEpoch(): number
}

/** Display reads existing terminal identities without issuing, adopting or rebinding handles. */
export function readIssuedTerminalHandles(source: IssuedHandleSource): AgentSenderHandleReads {
  return {
    readLeafHandle(leaf) {
      const existing = source.leafHandle(leaf)
      const record = existing ? source.handles().get(existing) : undefined
      if (
        existing &&
        record?.rendererGraphEpoch === source.rendererGraphEpoch() &&
        record.ptyId === leaf.ptyId &&
        record.ptyGeneration === leaf.ptyGeneration
      ) {
        return existing
      }
      if (!leaf.ptyId) {
        return null
      }
      const preAllocated = source.ptyHandles().get(leaf.ptyId)
      if (preAllocated) {
        return preAllocated
      }
      const retained = source.incarnations().get(leaf.ptyId)
      const incarnationId = source.ptys().get(leaf.ptyId)?.incarnationId ?? null
      return retained?.incarnationId === incarnationId ? retained.handle : null
    },
    readPtyHandles() {
      let records: Map<string, string> | undefined
      return (pty) => {
        const retained = source.incarnations().get(pty.ptyId)
        if (retained?.incarnationId === pty.incarnationId) {
          return retained.handle
        }
        const direct = source.ptyHandles().get(pty.ptyId)
        if (direct) {
          return direct
        }
        // One fallback index per walk, preserving the first matching canonical record.
        if (!records) {
          records = new Map()
          for (const [handle, record] of source.handles()) {
            if (
              record.runtimeId === source.runtimeId() &&
              record.ptyId &&
              record.tabId.startsWith('pty:') &&
              !records.has(record.ptyId)
            ) {
              records.set(record.ptyId, handle)
            }
          }
        }
        return records.get(pty.ptyId) ?? null
      }
    }
  }
}

import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { isWslUncPath } from '../../shared/wsl-paths'
import { readProcessStartTimeMs } from '../runtime/agent-session-process-identity-probe'
import {
  unavailableProviderResourceDiagnostic,
  type ProviderResourceDiagnosticQuery,
  type ProviderResourceDiagnosticResult
} from '../../shared/provider-resource-diagnostics'
import type { LaunchObservation } from './provider-resource-observations'

export function sameObject(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint }
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

export async function queryProviderResourceObservation(
  query: ProviderResourceDiagnosticQuery,
  context: {
    epoch: string
    records: ReadonlyMap<string, LaunchObservation>
    retains: (record: LaunchObservation) => boolean
    finishProbe: (record: LaunchObservation) => void
    ptyVerdict: (id: string, incarnationId: string) => 'live' | 'unverifiable' | 'exited'
  }
): Promise<ProviderResourceDiagnosticResult> {
  const { epoch, records, retains, finishProbe, ptyVerdict } = context
  const missing = (reason: ProviderResourceDiagnosticResult['reason']) => ({
    ...unavailableProviderResourceDiagnostic(query.requestId, reason),
    epoch: epoch
  })
  if (query.epoch && query.epoch !== epoch) {
    return missing('stale-epoch')
  }
  if (query.agent !== 'claude') {
    return missing('unsupported')
  }
  if (records.size === 0) {
    return missing('missing-retention')
  }
  const path = query.transcriptPath
  if (!path || !isAbsolute(path) || !path.endsWith('.jsonl') || path.length > 4096) {
    return missing('missing-retention')
  }
  if (process.platform === 'win32' && isWslUncPath(path)) {
    return missing('unsupported')
  }
  let activeRecord: LaunchObservation | undefined
  try {
    const object = await stat(path, { bigint: true })
    const candidates = [...records.values()].filter(
      (record) =>
        record.observation?.transcript && sameObject(record.observation.transcript.object, object)
    )
    if (candidates.length > 1) {
      return missing('conflicting-candidates')
    }
    const record = candidates[0]
    if (!record?.observation?.transcript) {
      return missing('missing-retention')
    }
    if (record.busy) {
      return missing('probe-capacity')
    }
    record.busy = true
    activeRecord = record
    const observation = record.observation
    const { transcript, hook } = observation
    if (!transcript) {
      return missing('missing-retention')
    }
    const currentObject = await stat(transcript.path, { bigint: true })
    if (!retains(record) || record.observation !== observation) {
      return missing('missing-retention')
    }
    if (!sameObject(currentObject, transcript.object)) {
      return missing('path-replaced')
    }
    if (record.rootPath && record.root) {
      const root = await stat(record.rootPath, { bigint: true })
      if (!sameObject(root, record.root)) {
        return missing('path-replaced')
      }
    }
    const start =
      record.pid && record.processStartTimeMs != null && process.platform !== 'win32'
        ? await readProcessStartTimeMs(record.pid)
        : null
    if (!retains(record) || record.observation !== observation) {
      return missing('missing-retention')
    }
    return {
      ...missing('missing-lifecycle-contract'),
      observationId: transcript.observationId,
      facts: {
        rootResolved: Boolean(record.root),
        objectObserved: true,
        objectScope: 'host-retained-read-descriptor',
        providerOpenHolder: 'unverifiable',
        reportedSessionMatches: query.sessionId === hook.sessionId,
        launchTokenMatches: hook.launchTokenMatches,
        pty: {
          id: record.ptyId,
          incarnationId: record.incarnationId,
          verdict: ptyVerdict(record.ptyId, record.incarnationId)
        },
        providerProcess: 'unverifiable',
        ptyRootStartTimeMatches: start === null ? null : start === record.processStartTimeMs,
        lifecycleBound: false,
        hookSequence: hook.sequence,
        hookKind: hook.kind,
        receivedAt: hook.receivedAt,
        sessionCorrelationId: hook.sessionCorrelationId
      }
    }
  } catch {
    return missing('missing-retention')
  } finally {
    if (activeRecord) {
      finishProbe(activeRecord)
    }
  }
}

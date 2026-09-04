import { isShellProcess } from '../../shared/agent-detection'
import type { RemoteForegroundEvidence } from '../../shared/foreground-process-evidence'
import { getStrictProcessTableSnapshotWithAge } from '../../shared/process-table-snapshot-reader'
import { resolveRemoteForegroundEvidence } from '../providers/agent-foreground-process'
import type { Session } from './session'
import { SessionNotFoundError } from './types'

export type TerminalHostProcessInspection = {
  foregroundProcess: string | null
  hasChildProcesses: boolean
  foregroundProcessEvidence?: RemoteForegroundEvidence
}

type RetiredIncarnation = { incarnationId: string; code: number; expiresAt: number }

export async function inspectTerminalHostProcess(args: {
  sessionId: string
  session: Session | null
  expectedIncarnationId?: string
  retiredIncarnation?: RetiredIncarnation
  authorityGeneration: string
  nextObservationEpoch: () => number
}): Promise<TerminalHostProcessInspection> {
  const { sessionId, session, expectedIncarnationId, retiredIncarnation } = args
  if (!session || !session.isAlive) {
    if (
      retiredIncarnation &&
      retiredIncarnation.expiresAt > Date.now() &&
      expectedIncarnationId === retiredIncarnation.incarnationId
    ) {
      return {
        foregroundProcess: null,
        hasChildProcesses: false,
        foregroundProcessEvidence: {
          authorityGeneration: args.authorityGeneration,
          observationEpoch: args.nextObservationEpoch(),
          capturedAgeMs: 0,
          ptyId: sessionId,
          ptyIncarnationId: retiredIncarnation.incarnationId,
          verdict: 'exited',
          reason: `pty_exit_${retiredIncarnation.code}`
        }
      }
    }
    throw new SessionNotFoundError(sessionId)
  }

  const foregroundProcess = session.getForegroundProcess()
  let evidence: RemoteForegroundEvidence
  if (expectedIncarnationId && expectedIncarnationId !== session.incarnationId) {
    evidence = unverifiableEvidence(args, session, 'incarnation_mismatch')
  } else {
    try {
      const snapshot = await getStrictProcessTableSnapshotWithAge()
      evidence = resolveRemoteForegroundEvidence(
        { rootPid: session.pid, fallbackProcess: foregroundProcess },
        {
          ptyId: sessionId,
          ptyIncarnationId: session.incarnationId,
          authorityGeneration: args.authorityGeneration,
          observationEpoch: args.nextObservationEpoch(),
          capturedAgeMs: snapshot.capturedAgeMs,
          platform: process.platform
        },
        snapshot.rows
      )
    } catch {
      evidence = unverifiableEvidence(args, session, 'process_table_unreadable')
    }
  }
  return {
    foregroundProcess: evidence.verdict === 'live' ? evidence.processName : foregroundProcess,
    hasChildProcesses: foregroundProcess !== null && !isShellProcess(foregroundProcess),
    foregroundProcessEvidence: evidence
  }
}

function unverifiableEvidence(
  args: {
    sessionId: string
    authorityGeneration: string
    nextObservationEpoch: () => number
  },
  session: Session,
  reason: string
): RemoteForegroundEvidence {
  return {
    authorityGeneration: args.authorityGeneration,
    observationEpoch: args.nextObservationEpoch(),
    capturedAgeMs: 0,
    ptyId: args.sessionId,
    ptyIncarnationId: session.incarnationId,
    verdict: 'unverifiable',
    reason
  }
}

import { isShellProcess } from '../../shared/agent-detection'
import type { RemoteForegroundEvidence } from '../../shared/foreground-process-evidence'
import { getCheapProcessTableSnapshot } from '../../shared/cheap-process-table-snapshot-reader'
import { getStrictProcessTableSnapshotWithAge } from '../../shared/process-table-snapshot-reader'
import { resolveRemoteForegroundEvidence } from '../providers/agent-foreground-process'
import { buildPaneProcessFingerprint } from '../providers/posix-pane-foreground-fingerprint'
import type { Session } from './session'
import {
  clearSteadyStateAnchor,
  getSteadyStateAnchor,
  rememberSteadyStateAnchor
} from './terminal-host-steady-state-anchor'
import { SessionNotFoundError } from './types'

export type TerminalHostProcessInspection = {
  foregroundProcess: string | null
  hasChildProcesses: boolean
  foregroundProcessEvidence?: RemoteForegroundEvidence
}

type RetiredIncarnation = { incarnationId: string; code: number; expiresAt: number }

/**
 * Tick tiers for a POSIX pane. `cheap` forks `ps` without `tty=`/`command=` (11-38x cheaper)
 * and answers from the anchored identity when the pane fingerprint is unchanged; anything it
 * cannot prove escalates to `full`, today's evidence capture.
 */
export type TerminalHostInspectionTier = 'full' | 'cheap'

export async function inspectTerminalHostProcess(args: {
  sessionId: string
  session: Session | null
  expectedIncarnationId?: string
  /** The caller is a self-correcting poll that only reads the process name, never evidence. */
  steadyState?: boolean
  retiredIncarnation?: RetiredIncarnation
  authorityGeneration: string
  nextObservationEpoch: () => number
  onTier?: (tier: TerminalHostInspectionTier) => void
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

  const incarnationMatches =
    !expectedIncarnationId || expectedIncarnationId === session.incarnationId
  if (args.steadyState === true && incarnationMatches) {
    const anchored = await readAnchoredForeground(session)
    if (anchored !== null) {
      args.onTier?.('cheap')
      // No evidence member on purpose: a tty-less capture cannot fence anything, and a
      // fabricated fence would be read by remote/restore consumers as an observation.
      return { foregroundProcess: anchored, hasChildProcesses: true }
    }
  }
  args.onTier?.('full')

  const foregroundProcess = session.getForegroundProcess()
  let evidence: RemoteForegroundEvidence
  if (!incarnationMatches) {
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
      await rememberSteadyStateAnchor(session, evidence, snapshot.rows)
    } catch {
      evidence = unverifiableEvidence(args, session, 'process_table_unreadable')
      clearSteadyStateAnchor(session)
    }
  }
  return {
    foregroundProcess: evidence.verdict === 'live' ? evidence.processName : foregroundProcess,
    hasChildProcesses: foregroundProcess !== null && !isShellProcess(foregroundProcess),
    foregroundProcessEvidence: evidence
  }
}

/**
 * Cheap tier, gated on an anchor the last full capture established. Start discovery therefore
 * keeps today's exact behaviour: a pane with no anchor never gets here. A recognized agent's
 * exit is a pid vanishing from the subtree, which the fingerprint always sees, so completion
 * detection is unaffected. Any mismatch, unreadable capture, changed node-pty name, or non-POSIX
 * host answers null -> full tier.
 */
async function readAnchoredForeground(session: Session): Promise<string | null> {
  const anchor = getSteadyStateAnchor(session)
  if (process.platform === 'win32' || !anchor) {
    return null
  }
  if (session.getForegroundProcess({ rawFallback: true }) !== anchor.rawFallback) {
    return null
  }
  try {
    const observed = await buildPaneProcessFingerprint(
      await getCheapProcessTableSnapshot(),
      session.pid
    )
    return observed !== null && observed === anchor.fingerprint ? anchor.agentName : null
  } catch {
    return null
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

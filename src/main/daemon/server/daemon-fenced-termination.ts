import type { PendingTerminalHistoryRetirements } from '../../pty/pending-terminal-history-retirement'
import { fencedTerminationHistoryPolicy } from '../../pty/pty-history-preserving-termination'
import type { IPtyProvider } from '../../providers/pty-provider-contract'
import type { DaemonSessionOwnerResolution } from '../providers/routing/daemon-session-owner-resolution'
import type {
  PtyFencedTerminationRequest,
  PtyFencedTerminationOutcome
} from '../../../shared/terminal/pty/lifecycle/pty-fenced-termination'
import type { TerminalHost } from '../terminal-host/terminal-host'
import type { DaemonPtySpawnPreparations } from './daemon-pty-spawn-preparations'
import type { DaemonSessionAttachments } from './daemon-session-attachments'

type FencedOwner<T extends IPtyProvider> = DaemonSessionOwnerResolution<T> | { kind: 'replaced' }

export async function terminateResolvedDaemonSession(
  request: PtyFencedTerminationRequest,
  resolve: () => Promise<FencedOwner<IPtyProvider>>,
  retirements?: PendingTerminalHistoryRetirements
): Promise<PtyFencedTerminationOutcome> {
  const captured = !fencedTerminationHistoryPolicy(request).keepHistory
    ? retirements?.find(request)
    : undefined
  const release = captured?.hold()
  try {
    const resolution = await resolve()
    if (resolution.kind === 'absent') {
      if (captured) {
        captured.removeHistory()
        release?.()
        await captured.finish(true)
      }
      return { outcome: 'already_exited' }
    }
    if (resolution.kind === 'replaced') {
      return { outcome: 'refused', reason: 'replaced' }
    }
    if (resolution.kind !== 'owner') {
      if (captured?.exited) {
        captured.removeHistory()
        release?.()
        await captured.finish(true)
        return { outcome: 'already_exited' }
      }
      return { outcome: 'refused', reason: 'unverifiable' }
    }
    if (!resolution.provider.supportsFencedTermination?.(request.id)) {
      return { outcome: 'refused', reason: 'unsupported' }
    }
    release?.()
    const completion = resolution.provider.killFenced?.(request)
    retirements?.capture(resolution.provider, request)
    return await (completion ?? { outcome: 'refused', reason: 'unsupported' })
  } finally {
    release?.()
  }
}

export async function handleDaemonFencedTermination(
  payload: {
    sessionId: string
    expectedIncarnationId?: string
    requireNoAgentOwner?: boolean
    requireUnattached?: boolean
  },
  deps: {
    host: TerminalHost
    preparations: Pick<DaemonPtySpawnPreparations, 'cancel'>
    attachments: Pick<DaemonSessionAttachments, 'clearInput'>
  }
): Promise<PtyFencedTerminationOutcome> {
  if (!payload.expectedIncarnationId) {
    return { outcome: 'refused', reason: 'unsupported' }
  }
  const termination = deps.host.beginFencedTermination({
    id: payload.sessionId,
    expectedIncarnationId: payload.expectedIncarnationId,
    requireNoAgentOwner: payload.requireNoAgentOwner === true,
    requireUnattached: payload.requireUnattached === true
  })
  if (!termination.accepted) {
    return termination.result
  }
  deps.preparations.cancel(payload.sessionId)
  deps.attachments.clearInput(payload.sessionId)
  return termination.completion
}

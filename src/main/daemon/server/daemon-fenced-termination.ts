import type { IPtyProvider } from '../../providers/pty/provider-contract'
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
  resolve: () => Promise<FencedOwner<IPtyProvider>>
): Promise<PtyFencedTerminationOutcome> {
  const resolution = await resolve()
  if (resolution.kind === 'absent') {
    return { outcome: 'already_exited' }
  }
  if (resolution.kind === 'replaced') {
    return { outcome: 'refused', reason: 'replaced' }
  }
  if (resolution.kind !== 'owner') {
    return { outcome: 'refused', reason: 'unverifiable' }
  }
  if (!resolution.provider.supportsFencedTermination?.(request.id)) {
    return { outcome: 'refused', reason: 'unsupported' }
  }
  return resolution.provider.killFenced?.(request) ?? { outcome: 'refused', reason: 'unsupported' }
}

export async function handleDaemonFencedTermination(
  payload: {
    sessionId: string
    expectedIncarnationId?: string
    requireNoAgentOwner?: boolean
    requireUnattached?: boolean
    requireIdle?: true
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
  if (payload.requireIdle) {
    try {
      const inspection = await deps.host.inspectProcess(payload.sessionId, {
        expectedIncarnationId: payload.expectedIncarnationId,
        runningWorkSinceMs: Date.now()
      })
      if (inspection.runningWork !== 'idle') {
        return {
          outcome: 'refused',
          reason: inspection.runningWork === 'running' ? 'running_work' : 'unverifiable'
        }
      }
    } catch {
      return { outcome: 'refused', reason: 'unverifiable' }
    }
  }
  const termination = deps.host.beginFencedTermination({
    id: payload.sessionId,
    expectedIncarnationId: payload.expectedIncarnationId,
    requireNoAgentOwner: payload.requireIdle === true || payload.requireNoAgentOwner === true,
    requireUnattached: payload.requireUnattached === true
  })
  if (!termination.accepted) {
    return termination.result
  }
  deps.preparations.cancel(payload.sessionId)
  deps.attachments.clearInput(payload.sessionId)
  return termination.completion
}

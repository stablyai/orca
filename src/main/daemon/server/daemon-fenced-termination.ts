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
    idleCheckSinceMs?: number
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
  const idleGuardStartedAt = payload.requireIdle ? Date.now() : undefined
  let idleShellPids: ReadonlySet<number> | undefined
  if (idleGuardStartedAt !== undefined) {
    try {
      const boundary = Number.isSafeInteger(payload.idleCheckSinceMs)
        ? payload.idleCheckSinceMs!
        : idleGuardStartedAt
      const inspection = await deps.host.inspectProcess(payload.sessionId, {
        expectedIncarnationId: payload.expectedIncarnationId,
        runningWorkSinceMs: boundary
      })
      const runningWork = inspection.runningWork
      if (runningWork !== 'idle') {
        return {
          outcome: 'refused',
          reason: runningWork === 'running' ? 'running_work' : 'unverifiable'
        }
      }
      const evidence = inspection.foregroundProcessEvidence
      if (evidence?.verdict === 'exited') {
        return { outcome: 'already_exited' }
      }
      if (process.platform !== 'win32') {
        if (evidence?.verdict !== 'live' || evidence.fence.platform !== 'posix') {
          return { outcome: 'refused', reason: 'unverifiable' }
        }
        idleShellPids = new Set([evidence.fence.shellPid, evidence.fence.foregroundPgid])
      }
    } catch {
      return { outcome: 'refused', reason: 'unverifiable' }
    }
  }
  const request: PtyFencedTerminationRequest = {
    id: payload.sessionId,
    expectedIncarnationId: payload.expectedIncarnationId,
    requireNoAgentOwner: payload.requireIdle === true || payload.requireNoAgentOwner === true,
    requireUnattached: payload.requireUnattached === true,
    ...(idleGuardStartedAt === undefined
      ? {}
      : { requireIdle: true, idleCheckSinceMs: idleGuardStartedAt })
  }
  const clearPendingInput = (): void => {
    deps.preparations.cancel(payload.sessionId)
    deps.attachments.clearInput(payload.sessionId)
  }
  const termination = idleShellPids
    ? deps.host.beginFencedTermination(request, {
        shellPids: idleShellPids,
        onCommitting: clearPendingInput
      })
    : deps.host.beginFencedTermination(request)
  if (!termination.accepted) {
    return termination.result
  }
  if (!idleShellPids) {
    clearPendingInput()
  }
  return termination.completion
}

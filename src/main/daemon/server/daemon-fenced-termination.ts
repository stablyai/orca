import type { IPtyProvider, RevalidateFencedPtyRoute } from '../../providers/pty/provider-contract'
import type {
  DaemonSessionOwnerResolution,
  DaemonSessionOwnerResolver
} from '../providers/routing/daemon-session-owner-resolution'
import type {
  PtyFencedTerminationRequest,
  PtyFencedTerminationOutcome
} from '../../../shared/terminal/pty/lifecycle/pty-fenced-termination'
import type { TerminalHost } from '../terminal-host/terminal-host'
import type { DaemonPtySpawnPreparations } from './daemon-pty-spawn-preparations'
import type { DaemonSessionAttachments } from './daemon-session-attachments'

type FencedOwner<T extends IPtyProvider> = DaemonSessionOwnerResolution<T> | { kind: 'replaced' }

export function terminateDaemonFencedRoute(
  resolver: Pick<
    DaemonSessionOwnerResolver<IPtyProvider>,
    'resolveTermination' | 'revalidateTermination'
  >,
  request: PtyFencedTerminationRequest,
  authorize?: () => void
): Promise<PtyFencedTerminationOutcome> {
  return terminateResolvedDaemonSession(
    request,
    authorize,
    () => resolver.resolveTermination(request.id, request.expectedIncarnationId),
    authorize
      ? (provider) =>
          resolver.revalidateTermination(request.id, request.expectedIncarnationId, provider)
      : undefined
  )
}

export async function terminateResolvedDaemonSession(
  request: PtyFencedTerminationRequest,
  authorize: (() => void) | undefined,
  resolve: () => Promise<FencedOwner<IPtyProvider>>,
  revalidate?: (provider: IPtyProvider) => ReturnType<RevalidateFencedPtyRoute>
): Promise<PtyFencedTerminationOutcome> {
  const resolution = await resolve()
  if (resolution.kind === 'absent') {
    authorize?.()
    return { outcome: 'already_exited' }
  }
  if (resolution.kind === 'replaced') {
    return { outcome: 'refused', reason: 'replaced' }
  }
  if (resolution.kind !== 'owner') {
    return { outcome: 'refused', reason: 'unverifiable' }
  }
  const { provider } = resolution
  if (!provider.supportsFencedTermination?.(request.id, request) || !provider.killFenced) {
    return { outcome: 'refused', reason: 'unsupported' }
  }
  if (revalidate) {
    return provider.killFenced(request, authorize, () => revalidate(provider))
  }
  return authorize ? provider.killFenced(request, authorize) : provider.killFenced(request)
}

export async function handleDaemonFencedTermination(
  payload: {
    sessionId: string
    expectedIncarnationId?: string
    requireNoAgentOwner?: boolean
    requireUnattached?: boolean
    verifyExitOnly?: true
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
    requireUnattached: payload.requireUnattached === true,
    ...(payload.verifyExitOnly === true ? { verifyExitOnly: true } : {})
  })
  if (!termination.accepted) {
    return termination.result
  }
  deps.preparations.cancel(payload.sessionId)
  deps.attachments.clearInput(payload.sessionId)
  return termination.completion
}

import type { RevalidateFencedPtyRoute } from '../pty/provider-contract'
import type {
  PtyFencedTerminationOutcome,
  PtyFencedTerminationRequest
} from '../../../shared/terminal/pty/lifecycle/pty-fenced-termination'
import {
  exitedLocalPtyIncarnations,
  ptyIncarnations,
  ptyProcesses
} from './local-pty-provider-state'
import { shutdownLocalPty } from './local-pty-termination'

export function supportsLocalPtyFencedTermination(
  _id: string,
  request?: PtyFencedTerminationRequest
): boolean {
  return (
    request?.requireNoAgentOwner === false &&
    request.requireUnattached === false &&
    request.switchCondition === undefined
  )
}

export async function killLocalPtyFenced(
  {
    id,
    expectedIncarnationId,
    requireNoAgentOwner,
    requireUnattached,
    keepHistory,
    switchCondition
  }: PtyFencedTerminationRequest,
  authorize?: () => void,
  revalidateRoute?: RevalidateFencedPtyRoute
): Promise<PtyFencedTerminationOutcome> {
  if (!ptyProcesses.has(id)) {
    return exitedLocalPtyIncarnations.get(id) === expectedIncarnationId
      ? { outcome: 'already_exited' }
      : { outcome: 'refused', reason: 'unverifiable' }
  }
  if (ptyIncarnations.get(id) !== expectedIncarnationId) {
    return { outcome: 'refused', reason: 'replaced' }
  }
  if (requireUnattached) {
    return { outcome: 'refused', reason: 'attached' }
  }
  if (requireNoAgentOwner || switchCondition) {
    return { outcome: 'refused', reason: 'unsupported' }
  }
  try {
    const route = revalidateRoute ? await revalidateRoute() : undefined
    if (route === 'already_exited' || !ptyProcesses.has(id)) {
      if (exitedLocalPtyIncarnations.get(id) !== expectedIncarnationId) {
        return { outcome: 'refused', reason: 'unverifiable' }
      }
      authorize?.()
      return { outcome: 'already_exited' }
    }
    await shutdownLocalPty(id, {
      immediate: true,
      keepHistory,
      authorize: () => {
        if (ptyIncarnations.get(id) !== expectedIncarnationId) {
          throw new Error('terminal_pane_owner_changed')
        }
        route?.()
        authorize?.()
      }
    })
    return { outcome: 'ended' }
  } catch {
    return { outcome: 'refused', reason: 'unverifiable' }
  }
}

import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import type { IPtyProvider } from '../../../providers/pty/provider-contract'
import { LocalPtyProvider } from '../../../providers/local-pty/local-pty-provider'
import { isRendererViewShowingPty, ptySizes } from '../delivery/visibility-state'
import { isHiddenRendererPty } from '../delivery/pty-hidden-delivery-gate'
import {
  admitProviderReattachLaunchIdentity,
  reattachLaunchBinding
} from '../pane/launch-authority'
import { getProviderForPty, localProvider, resolvePtyExecutionHost } from '../provider/registry'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { seedAttachedRuntimeTerminal } from './seed-attached-runtime-terminal'
import { hideRuntimeOwnedRendererDelivery } from './spawn-hidden-delivery'

export async function attachPtyFromRuntimeController(
  deps: Pick<
    PtyRuntimeControllerDeps,
    'runtime' | 'transitionSpawnHiddenRendererPtyDeliveryState' | 'syncPtyBackgroundedDelivery'
  >,
  ptyId: string
): Promise<boolean> {
  if (resolvePtyExecutionHost(ptyId) !== LOCAL_EXECUTION_HOST_ID) {
    return false
  }
  let provider: IPtyProvider
  try {
    provider = getProviderForPty(ptyId)
  } catch {
    return false
  }
  if (provider !== localProvider || provider instanceof LocalPtyProvider) {
    return false
  }
  // A pane's own hidden claim stays its own; a reveal or exit clears main's.
  if (!isRendererViewShowingPty(ptyId) && !isHiddenRendererPty(ptyId)) {
    hideRuntimeOwnedRendererDelivery(deps, ptyId)
  }
  try {
    const sequenceBeforeProviderAttach = deps.runtime?.getPtyOutputSequence?.(ptyId) ?? 0
    const sizeBeforeAttach = ptySizes.get(ptyId)
    const attachResult = await provider.attach(ptyId)
    if (attachResult?.providerSequence) {
      deps.runtime?.synchronizePtyOutputSequenceFromProvider?.(
        ptyId,
        attachResult.providerSequence,
        sequenceBeforeProviderAttach
      )
    }
    if (attachResult) {
      seedAttachedRuntimeTerminal(deps.runtime, attachResult, sizeBeforeAttach)
      deps.runtime?.restoreAttachedLaunch(ptyId, {
        incarnationId: attachResult.incarnationId,
        identity: admitProviderReattachLaunchIdentity({ ...attachResult, isReattach: true }),
        reattach: reattachLaunchBinding({ ...attachResult, isReattach: true }).reattach
      })
    }
    deps.syncPtyBackgroundedDelivery?.(ptyId, 'main-attach')
    return true
  } catch {
    return false
  }
}

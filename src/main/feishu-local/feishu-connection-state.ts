import type { FeishuLocalState } from '../../shared/bots/feishu-local'
import type { Binding } from './feishu-binding'
import type { FeishuStore } from './feishu-store-ops'
export async function feishuConnectionState(
  binding: Binding,
  inbox: FeishuStore,
  phase: FeishuLocalState['status'],
  retry: 'retrying' | 'upload-permission' | null,
  available: boolean,
  pairing?: { text: string }
): Promise<FeishuLocalState> {
  const { account } = binding
  const status =
    phase === 'credentials-required'
      ? phase
      : (await inbox.needsReview(account))
        ? 'review'
        : !available
          ? 'paused'
          : retry && phase === 'listening'
            ? retry
            : phase
  return {
    method: binding.profile === null ? 'sdk' : 'cli',
    ...(binding.profile === null ? {} : { profile: binding.profile }),
    appId: binding.app,
    ownerId: binding.owner ?? undefined,
    status,
    ...((status === 'pairing' || status === 'verification-failed') && pairing
      ? { pairingText: pairing.text }
      : {})
  }
}

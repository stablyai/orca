import { hasVisibleOverlay } from '@/lib/visible-overlay'
import { useAppStore } from '../store'
import { resolveLatestAttentionThread } from '../components/activity/latest-attention-thread'
import { activateActivityThreadTarget } from '../components/activity/activity-thread-actions'
import type { KeybindingActionId } from '../../../shared/keybindings'

export function runLatestAttention(
  creationLayoutActive: boolean,
  claim: (actionId: KeybindingActionId, run: () => void) => boolean
): boolean {
  const store = useAppStore.getState()
  if (creationLayoutActive || store.activeModal !== 'none' || hasVisibleOverlay()) {
    return false
  }
  const thread = resolveLatestAttentionThread(store)
  if (!thread) {
    return false
  }
  return claim('worktree.jumpToLatestAttention', () => activateActivityThreadTarget(thread))
}

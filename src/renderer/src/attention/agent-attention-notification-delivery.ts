/**
 * Sending one attention delivery request to main, and the client-side follow-ups that go with it.
 *
 * Extracted so a non-terminal surface reuses this rather than restating it: the success sound and
 * the blocked-permission fallback are policy, and a second copy of them would drift. What the
 * request SAYS still belongs to each surface — a terminal arbitrates a title against a hook
 * snapshot, a structured chat reads its projected row — so only the send lives here.
 *
 * Whether a banner actually appears is main's call, not this module's: the enabled/source
 * preferences and the suppress-while-focused setting are applied there, after mobile fan-out.
 * A caller must never promise the user a banner.
 */
import { playDesktopNotificationSound } from '@/lib/desktop-notification-sound'
import { showBlockedNotificationFallbackToast } from '@/lib/blocked-notification-fallback'
import type { NotificationDispatchRequest } from '../../../shared/notification-settings-types'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { useAppStore } from '@/store'
import { getConcealedRepoIdsFromState } from '@/store/concealed-repo-selector'
import { isIncognitoRepo } from '../../../shared/incognito-projects'

export type AgentAttentionNotificationSound = {
  customSoundId: string
  customSoundVolume: number | null
}

export function deliverAgentAttentionNotification(
  request: NotificationDispatchRequest,
  sound: AgentAttentionNotificationSound
): void {
  // Why: a banner, sound or phone push would name a locked incognito project; unread stays hidden with its row.
  const incognito = request.worktreeId ? readWorktreeIncognito(request.worktreeId) : 'shown'
  if (incognito === 'concealed') {
    return
  }
  void window.api.notifications
    // Why: unlocked here still means hidden on phones, which have no unlock of their own.
    .dispatch(incognito === 'revealed' ? { ...request, repoIncognito: true } : request)
    .then((result) => {
      if (result.delivered) {
        void playDesktopNotificationSound(sound.customSoundId, sound.customSoundVolume)
        return
      }
      // Why: macOS is silently swallowing notifications (permission off or prompt unanswered) —
      // surface an in-app pointer at the fix instead of letting the alert vanish without a trace.
      if (result.reason === 'blocked-by-system') {
        showBlockedNotificationFallbackToast()
      }
    })
    .catch((err) => {
      console.warn('Failed to dispatch notification:', err)
    })
}

function readWorktreeIncognito(worktreeId: string): 'shown' | 'revealed' | 'concealed' {
  const state = useAppStore.getState()
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  if (getConcealedRepoIdsFromState(state).has(repoId)) {
    return 'concealed'
  }
  return state.repos.some((repo) => repo.id === repoId && isIncognitoRepo(repo))
    ? 'revealed'
    : 'shown'
}

/** The sound preferences one delivery reads, defaulted the way the dispatch path always has. */
export function readAgentAttentionNotificationSound(settings: {
  notifications?: { customSoundId?: string; customSoundVolume?: number | null } | undefined
}): AgentAttentionNotificationSound {
  return {
    customSoundId: settings.notifications?.customSoundId ?? 'system',
    customSoundVolume: settings.notifications?.customSoundVolume ?? null
  }
}

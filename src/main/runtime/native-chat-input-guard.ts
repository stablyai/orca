import type { NativeChatTargetRead } from '../../shared/native-chat-target-read'

// Why bounded: action ids are client-chosen; a PTY only needs the recent ones to fence delayed steps.
const MAX_TRACKED_ACTIONS_PER_PTY = 64

type PinnedAction = { incarnationId: string | null; presentationToken: string | null }

type PtyChatActions = {
  started: Map<string, PinnedAction>
  /** Refused or interrupted actions; never admitted again on this PTY, even if chat returns. */
  cancelled: Set<string>
}

export type NativeChatInputVerdict = 'admitted' | 'refused'

/** The committed presentation could not be read now (renderer down/slow): not an exit verdict. */
export type NativeChatTargetObservation = NativeChatTargetRead | 'unverifiable'

function trim<T>(entries: Map<string, T> | Set<string>): void {
  while (entries.size > MAX_TRACKED_ACTIONS_PER_PTY) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) {
      return
    }
    entries.delete(oldest)
  }
}

/**
 * Host-side fence for chat composer writes, decided per chunk from the committed presentation (no
 * exit latch): a write lands only while the PTY's pane may still render chat. An action pins its
 * PTY incarnation and presentation token at admission; a refusal, a rebinding or any presentation
 * change after that cancels it for good, while a new action may use a newly committed chat at once.
 */
export class NativeChatInputGuard {
  private readonly byPtyId = new Map<string, PtyChatActions>()

  admit(
    ptyId: string,
    incarnationId: string | null,
    actionId: string,
    target: NativeChatTargetObservation
  ): NativeChatInputVerdict {
    const existing = this.byPtyId.get(ptyId)
    if (existing?.cancelled.has(actionId)) {
      return 'refused'
    }
    // Why before allocating: an unknown target must not grow the registry (and writes nothing).
    if (target !== 'unverifiable' && target.kind === 'unknown-target') {
      return 'refused'
    }
    const state = existing ?? { started: new Map(), cancelled: new Set() }
    this.byPtyId.set(ptyId, state)
    const pinned = state.started.get(actionId)
    const token =
      target !== 'unverifiable' && target.kind === 'chat-target' ? target.presentationToken : null
    const moved =
      pinned !== undefined &&
      (pinned.incarnationId !== incarnationId ||
        (pinned.presentationToken !== null && token !== null && pinned.presentationToken !== token))
    if ((target !== 'unverifiable' && target.kind === 'not-chat-target') || moved) {
      state.started.delete(actionId)
      state.cancelled.add(actionId)
      trim(state.cancelled)
      return 'refused'
    }
    if (!pinned) {
      state.started.set(actionId, { incarnationId, presentationToken: token })
      trim(state.started)
    } else if (pinned.presentationToken === null && token !== null) {
      pinned.presentationToken = token
    }
    return 'admitted'
  }

  /** The PTY itself exited or was replaced; its ids can never be addressed again. */
  forget(ptyId: string): void {
    this.byPtyId.delete(ptyId)
  }
}

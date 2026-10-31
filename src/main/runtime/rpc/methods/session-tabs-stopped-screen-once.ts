import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'

type ScreenCarrier = {
  worktree: string
  removed?: true
  tabs: RuntimeMobileSessionTabsResult['tabs']
}

export type SessionTabsStoppedScreenOnce = <TFrame extends ScreenCarrier>(frame: TFrame) => TFrame

/**
 * A stopped switch source's held screen never changes for its exact process, so each stream carries
 * it in the first frame naming that process and later frames carry the fact without it: a title
 * tick elsewhere in the workspace then costs no image serialization. Every consumer keeps the copy
 * it already holds for that process; a new stream (a reload, a new client) gets it again.
 */
export function createSessionTabsStoppedScreenOnce(): SessionTabsStoppedScreenOnce {
  const sentByWorktree = new Map<string, Set<string>>()
  return <TFrame extends ScreenCarrier>(frame: TFrame): TFrame => {
    if (frame.removed === true) {
      sentByWorktree.delete(frame.worktree)
      return frame
    }
    const sent = sentByWorktree.get(frame.worktree)
    const shown = new Set<string>()
    let tabs: TFrame['tabs'] | null = null
    frame.tabs.forEach((tab, index) => {
      const fact = tab.type === 'terminal' ? tab.stoppedSwitchSource : undefined
      if (tab.type !== 'terminal' || !fact?.screen) {
        return
      }
      const key = `${fact.ptyId}\0${fact.incarnationId}`
      shown.add(key)
      if (sent?.has(key)) {
        const { screen: _sent, ...withoutScreen } = fact
        tabs ??= [...frame.tabs]
        tabs[index] = { ...tab, stoppedSwitchSource: withoutScreen }
      }
    })
    // Track current membership, so a process whose row left and came back is sent again.
    if (shown.size > 0) {
      sentByWorktree.set(frame.worktree, shown)
    } else {
      sentByWorktree.delete(frame.worktree)
    }
    return tabs ? { ...frame, tabs } : frame
  }
}

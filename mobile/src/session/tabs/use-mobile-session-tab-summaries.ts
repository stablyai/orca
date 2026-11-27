import { useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import {
  buildMobileSessionTabSummary,
  type MobileSessionTabSummary
} from './mobile-session-tab-rows'
import type { MobileSessionController } from '../use-mobile-session-controller'

/** Every tab as the top bar and the sidebar draw it; the open tab never reads unread. */
export function useMobileSessionTabSummaries(
  controller: Pick<MobileSessionController, 'visibleTabs' | 'terminals' | 'activeSessionTabId'>,
  /** The route bot's main chat, whose recorded name "Home" reads in the phone's language. */
  homeChatId: string | null,
  /** The caller's one minute clock, so each owner wakes once a minute. */
  now: number
): MobileSessionTabSummary[] {
  const t = useMobileTranslation()
  const { visibleTabs, terminals, activeSessionTabId } = controller
  return useMemo(
    () =>
      visibleTabs.map((tab) => {
        const built = buildMobileSessionTabSummary(tab, terminals, now, t)
        const summary =
          homeChatId !== null &&
          tab.type === 'agent-session' &&
          tab.sessionId === homeChatId &&
          built.title === 'Home'
            ? { ...built, title: t('bots.tabs.homeTitle', 'Home') }
            : built
        // The tab on screen is being read (useMarkViewedAgentRead), so it never rings.
        return summary.unread && tab.id === activeSessionTabId
          ? { ...summary, unread: false }
          : summary
      }),
    [visibleTabs, terminals, now, activeSessionTabId, homeChatId, t]
  )
}

/**
 * Hands the top bar's tab summaries to the sidebar without re-rendering the session around them:
 * the bar builds them once per change or minute, and only the sidebar reads them back.
 */
export function useMobileSessionTabSummaryChannel() {
  const [channel] = useState(() => {
    let value: readonly MobileSessionTabSummary[] = []
    const listeners = new Set<() => void>()
    return {
      get: () => value,
      set: (next: readonly MobileSessionTabSummary[]) => {
        if (next !== value) {
          value = next
          listeners.forEach((notify) => notify())
        }
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    }
  })
  return channel
}

export type MobileSessionTabSummaryChannel = ReturnType<typeof useMobileSessionTabSummaryChannel>

export function usePublishTabSummaries(
  channel: MobileSessionTabSummaryChannel,
  tabs: readonly MobileSessionTabSummary[]
): void {
  useLayoutEffect(() => channel.set(tabs), [channel, tabs])
}

export function useTabSummaries(
  channel: MobileSessionTabSummaryChannel
): readonly MobileSessionTabSummary[] {
  return useSyncExternalStore(channel.subscribe, channel.get, channel.get)
}

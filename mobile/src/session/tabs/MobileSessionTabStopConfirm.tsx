import { useEffect, useRef, useState } from 'react'
import { ConfirmModal } from '../../components/sheets/ConfirmModal'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { MobileSessionTab } from './mobile-session-tabs'
import type { MobileSessionTabSummary } from './mobile-session-tab-rows'
import { finishedMobileSessionTabs } from './mobile-session-tabs-sheet-sections'
import type { AgentDotState } from '../../worktree/agent-lineage/agent-row-display'

/** A close that asks first: one that would stop an agent mid-turn or mid-question, or a batch of finished tabs. */
export type MobileSessionTabStop = {
  tabs: readonly MobileSessionTab[]
  title: string
  kind: 'working' | 'waiting' | 'finished'
}

/** Whether closing an agent in this state stops it mid-turn or mid-question; failed or finished agents just close. */
export function mobileSessionTabStopKind(
  state: AgentDotState | undefined
): 'working' | 'waiting' | null {
  switch (state) {
    case 'working':
    case 'monitoring':
      return 'working'
    case 'waiting':
    case 'blocked':
    case 'permission':
      return 'waiting'
    case 'done':
    case 'failed':
    case 'idle':
    case 'interrupted':
    case 'unconfirmed':
    case 'unverifiable':
    case undefined:
      return null
  }
}

/** The confirm for a close that asks first; `ask` opens it, confirming closes every tab named. */
export function useMobileSessionTabStopConfirm(
  closeTab: (tab: MobileSessionTab, closingTogether: readonly string[]) => Promise<unknown>,
  rows: readonly MobileSessionTabSummary[],
  activeTabId: string | null
) {
  const t = useMobileTranslation()
  // The confirm answers after the sheet has gone; a named tab may have started working, or closed, since.
  const latestRef = useRef({ rows, activeTabId })
  useEffect(() => {
    latestRef.current = { rows, activeTabId }
  })
  const stillFinished = (tabIds: readonly string[]) =>
    finishedMobileSessionTabs(latestRef.current.rows, latestRef.current.activeTabId)
      .filter((row) => tabIds.includes(row.tab.id))
      .map((row) => row.tab)
  // Kept after the confirm closes, so its words hold still while it slides away.
  const [stop, setStop] = useState<MobileSessionTabStop | null>(null)
  const [open, setOpen] = useState(false)
  const ask = (next: MobileSessionTabStop) => {
    setStop(next)
    setOpen(true)
  }
  const title = stop?.title ?? ''
  const count = stop?.tabs.length ?? 0
  const copy =
    stop?.kind === 'finished'
      ? {
          title:
            count === 1
              ? t('session.tabsSheet.closeFinishedTitle_one', 'Close {{count}} finished tab?', {
                  count
                })
              : t('session.tabsSheet.closeFinishedTitle_other', 'Close {{count}} finished tabs?', {
                  count
                }),
          message: undefined,
          confirm:
            count === 1
              ? t('session.bulkTabClose.confirm_one', 'Close {{count}} tab', { count })
              : t('session.bulkTabClose.confirm_other', 'Close {{count}} tabs', { count })
        }
      : {
          title: t('session.tabsSheet.stopTitle', 'Stop and close?'),
          message:
            stop?.kind === 'waiting'
              ? t(
                  'session.tabsSheet.stopWaiting',
                  '{{title}} is waiting for you. Closing the tab stops it.',
                  { title }
                )
              : t(
                  'session.tabsSheet.stopWorking',
                  '{{title}} is still working. Closing the tab stops it.',
                  { title }
                ),
          confirm: t('session.tabsSheet.stopConfirm', 'Stop and close')
        }
  const confirm = (
    <ConfirmModal
      visible={open}
      title={copy.title}
      message={copy.message}
      confirmLabel={copy.confirm}
      destructive
      onConfirm={() => {
        const named = stop?.tabs ?? []
        const closing =
          stop?.kind === 'finished' ? stillFinished(named.map((tab) => tab.id)) : named
        const ids = closing.map((tab) => tab.id)
        void (async () => {
          for (const tab of closing) {
            // Closes go one by one; skip a finished tab that was opened or restarted meanwhile.
            if (stop?.kind === 'finished' && stillFinished([tab.id]).length === 0) {
              continue
            }
            await closeTab(tab, ids)
          }
        })()
      }}
      onCancel={() => setOpen(false)}
    />
  )
  return { ask, confirm }
}

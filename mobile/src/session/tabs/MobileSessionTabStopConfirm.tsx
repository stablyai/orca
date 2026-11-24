import { useState } from 'react'
import { ConfirmModal } from '../../components/sheets/ConfirmModal'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { MobileSessionTab } from './mobile-session-tabs'
import type { AgentDotState } from '../../worktree/agent-lineage/agent-row-display'

/** A close that would stop an agent mid-turn or mid-question, so it asks first. */
export type MobileSessionTabStop = {
  tabs: readonly MobileSessionTab[]
  title: string
  kind: 'working' | 'waiting'
}

/** Whether closing an agent in this state stops it mid-turn or mid-question; failed or finished agents just close. */
export function mobileSessionTabStopKind(
  state: AgentDotState | undefined
): MobileSessionTabStop['kind'] | null {
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

/** "Stop and close?" for a running agent's tab; `ask` opens it, confirming closes every tab named. */
export function useMobileSessionTabStopConfirm(
  closeTab: (tab: MobileSessionTab, closingTogether: readonly string[]) => Promise<void>
) {
  const t = useMobileTranslation()
  // Kept after the confirm closes, so its words hold still while it slides away.
  const [stop, setStop] = useState<MobileSessionTabStop | null>(null)
  const [open, setOpen] = useState(false)
  const ask = (next: MobileSessionTabStop) => {
    setStop(next)
    setOpen(true)
  }
  const title = stop?.title ?? ''
  const confirm = (
    <ConfirmModal
      visible={open}
      title={t('session.tabsSheet.stopTitle', 'Stop and close?')}
      message={
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
            )
      }
      confirmLabel={t('session.tabsSheet.stopConfirm', 'Stop and close')}
      destructive
      onConfirm={() => {
        const closing = stop?.tabs ?? []
        const ids = closing.map((tab) => tab.id)
        void (async () => {
          for (const tab of closing) {
            await closeTab(tab, ids)
          }
        })()
      }}
      onCancel={() => setOpen(false)}
    />
  )
  return { ask, confirm }
}

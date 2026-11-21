import { useCallback, useState } from 'react'
import type { BotAutomationRow } from '../../../src/shared/bots/bot-automation-rows'
import type { BotAutomationView } from '../../../src/shared/bots/bot-activity-schema'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { automationDeleteWrite } from '../automations/automation-operations'
import { automationRunNow, automationSetEnabled } from './bot-automation-operations'

type Row = BotAutomationRow<BotAutomationView>

/** The bot's Automations as its host lists them with Activity, plus Run Now and Pause/Resume, and its
 *  waits with Cancel. */
export function useBotAutomations({
  client,
  rows,
  waits,
  showToast
}: {
  client: RpcClient | null
  /** Null while loading or from a host that doesn't compose them yet. */
  rows: readonly Row[] | null
  waits: readonly Row[]
  showToast: (message: string, durationMs?: number) => void
}) {
  // A saved switch, until the host's next list carries a newer record of that automation.
  const t = useMobileTranslation()
  const [saved, setSaved] = useState<ReadonlyMap<string, BotAutomationView>>(new Map())
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set())
  // A cancelled wait is gone on the host; the next Activity read stops listing it too.
  const [cancelled, setCancelled] = useState<ReadonlySet<string>>(new Set())

  const shown = rows?.map((row) => {
    const mine = saved.get(row.automation.id)
    return mine && mine.updatedAt >= row.automation.updatedAt ? { ...row, automation: mine } : row
  })

  const mark = (id: string, busy: boolean) =>
    setSaving((previous) => {
      const next = new Set(previous)
      if (busy) {
        next.add(id)
      } else {
        next.delete(id)
      }
      return next
    })

  const setAutomationEnabled = useCallback(
    async (id: string, next: boolean) => {
      if (!client) {
        return
      }
      mark(id, true)
      try {
        const { automation } = automationSetEnabled.interpret(
          await automationSetEnabled.request(
            client,
            { id, updates: { enabled: next } },
            { failWhenDisconnected: true }
          )
        )
        setSaved((previous) => new Map(previous).set(automation.id, automation))
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : t('bots.saveFailed', 'Couldn’t save'),
          1800
        )
      } finally {
        mark(id, false)
      }
    },
    [client, showToast, t]
  )

  const runNow = useCallback(
    async (id: string) => {
      if (!client) {
        return
      }
      mark(id, true)
      try {
        automationRunNow.interpret(
          await automationRunNow.request(client, { id }, { failWhenDisconnected: true })
        )
        showToast(t('bots.automations.runQueued', 'Automation run queued.'))
      } catch (error) {
        showToast(
          error instanceof Error
            ? error.message
            : t('bots.automations.runFailed', 'Couldn’t start the run'),
          1800
        )
      } finally {
        mark(id, false)
      }
    },
    [client, showToast, t]
  )

  const cancelWait = useCallback(
    async (id: string) => {
      if (!client) {
        return
      }
      mark(id, true)
      try {
        automationDeleteWrite.interpret(
          await automationDeleteWrite.request(client, { id }, { failWhenDisconnected: true })
        )
        setCancelled((previous) => new Set(previous).add(id))
      } catch (error) {
        showToast(
          error instanceof Error ? error.message : t('bots.saveFailed', 'Couldn’t save'),
          1800
        )
      } finally {
        mark(id, false)
      }
    },
    [client, showToast, t]
  )

  return {
    rows: shown ?? null,
    waits: waits.filter((row) => !cancelled.has(row.automation.id)),
    saving,
    setAutomationEnabled,
    runNow,
    cancelWait
  }
}

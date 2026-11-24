// A bot's wait deleted while it still waits was cancelled; the bot keeps that so the wait's chat card says so.
import { onceClaimed } from '../../shared/automation-once'
import type { AutomationOwnerPrecondition } from '../../shared/automations/ownership/automation-owner-precondition'
import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import type { BotCancelledWait } from '../../shared/bots/bot-cancelled-waits'

/** The runtime calls a cancel makes. */
export type WaitCancelRuntime = {
  showAutomation: (id: string) => Pick<Automation, 'once'> & { bot?: { botId: string } | null }
  listAutomationRuns: (id: string) => readonly Pick<AutomationRun, 'status' | 'trigger'>[]
  deleteAutomation: (
    id: string,
    expectedOwner?: AutomationOwnerPrecondition
  ) => Promise<{ removed: boolean; id: string }>
  bots: {
    update: (botId: string, updates: { cancelledWait: BotCancelledWait }) => Promise<unknown>
  }
  /** The scheduler's lane for this automation, where a wait's run is admitted. */
  inAutomationLane: <T>(automationId: string, operation: () => Promise<T>) => Promise<T>
}

/** The bot whose wait this still is, or null for any other automation or one already gone. */
function botOfWaitingWait(runtime: WaitCancelRuntime, id: string): string | null {
  try {
    const automation = runtime.showAutomation(id)
    const botId = automation.once ? automation.bot?.botId : undefined
    return botId && !onceClaimed(runtime.listAutomationRuns(id)) ? botId : null
  } catch {
    // Unknown or not readable: the delete itself reports why.
    return null
  }
}

/**
 * Deletes the automation; a bot's wait that still waited is recorded on its bot as cancelled. Done in the
 * wait's scheduler lane, so a run is either admitted before (and the wait isn't cancelled) or never.
 */
export async function deleteAutomationRecordingCancelledWait(
  runtime: WaitCancelRuntime,
  id: string,
  expectedOwner: AutomationOwnerPrecondition | undefined
): Promise<{ removed: boolean; id: string }> {
  const { botId, result } = await runtime.inAutomationLane(id, async () => ({
    botId: botOfWaitingWait(runtime, id),
    result: await runtime.deleteAutomation(id, expectedOwner)
  }))
  if (botId && result.removed) {
    // The wait is gone either way; a bot deleted meanwhile has no card left to update.
    await runtime.bots
      .update(botId, { cancelledWait: { automationId: id, at: Date.now() } })
      .catch((error: unknown) => console.warn('[bots] could not record a cancelled wait', error))
  }
  return result
}

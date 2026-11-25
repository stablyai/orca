import type { Automation } from '../../shared/automations/automation-definition'

/** Deletes each automation that runs as the bot, through the runtime's own automation delete. */
export async function deleteAutomationsOfBot(
  automations: readonly Automation[],
  botId: string,
  deleteAutomation: (automationId: string) => Promise<unknown>
): Promise<void> {
  for (const automation of automations) {
    if (automation.bot?.botId === botId) {
      await deleteAutomation(automation.id)
    }
  }
}

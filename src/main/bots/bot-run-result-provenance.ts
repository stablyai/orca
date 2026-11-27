// A bot automation's result posted away from the thread the automation was made in says where it
// came from, so a reader of the channel or issue sees why it is there.
import type { Automation } from '../../shared/automations/automation-definition'
import { originThreadText } from '../../shared/automations/automation-results-place'

export function withProvenance(
  message: string,
  automation: Pick<Automation, 'name' | 'bot'>
): string {
  const origin = automation.bot?.originThread
  if (!origin) {
    return message
  }
  return `_From the automation “${automation.name}”, created in ${originThreadText(origin)}._\n\n${message}`
}

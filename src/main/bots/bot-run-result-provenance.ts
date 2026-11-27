// A bot automation's result posted away from the thread the automation was made in says where it
// came from, so a reader of the channel or issue sees why it is there.
import type { Automation } from '../../shared/automations/automation-definition'
import { originThreadText } from '../../shared/automations/automation-results-place'

/** The line a post opens with: the thread it was made in when the post lands elsewhere, "this
 *  thread" when the post is a reply there. */
export function withProvenance(
  message: string,
  automation: Pick<Automation, 'name' | 'bot'>,
  inOriginThread = false
): string {
  const origin = automation.bot?.originThread
  if (!origin) {
    return message
  }
  const where = inOriginThread ? 'this thread' : originThreadText(origin)
  return `_From the automation “${automation.name}”, created in ${where}._\n\n${message}`
}

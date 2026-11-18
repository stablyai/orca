import type { BotGroup } from '../../../src/shared/bots/bot-group'

/** The saved record in the list; it carries no listing fields, so the listed preview and place stay,
 *  and a newer revision the change event already listed wins. */
export function withSavedGroup(listed: readonly BotGroup[], saved: BotGroup): BotGroup[] {
  const current = listed.find((entry) => entry.id === saved.id)
  if (current && current.revision > saved.revision) {
    return [...listed]
  }
  const merged: BotGroup = {
    ...saved,
    ...(current?.latest ? { latest: current.latest } : {}),
    ...(current?.sidebarOrder !== undefined ? { sidebarOrder: current.sidebarOrder } : {})
  }
  return current
    ? listed.map((entry) => (entry.id === saved.id ? merged : entry))
    : [...listed, merged]
}

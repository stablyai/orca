import type { WorkspaceViewChoice } from '../../../src/shared/workspace-view/workspace-view-options'
import type { WorktreeCardProperty } from '../../../src/shared/ui-chrome-types'

// Omit Ports: the phone has no port scan; desktop retains it.
const PHONE_HIDDEN_CARD_PROPERTIES: ReadonlySet<WorktreeCardProperty> = new Set(['ports'])

export function phoneCardPropertyChoices<Choice extends WorkspaceViewChoice<WorktreeCardProperty>>(
  choices: readonly Choice[]
): Choice[] {
  return choices.filter((choice) => !PHONE_HIDDEN_CARD_PROPERTIES.has(choice.id))
}

export function withoutPhoneHiddenProperties(
  properties: readonly WorktreeCardProperty[]
): WorktreeCardProperty[] {
  return properties.filter((property) => !PHONE_HIDDEN_CARD_PROPERTIES.has(property))
}

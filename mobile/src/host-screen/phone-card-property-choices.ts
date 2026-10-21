import type { WorkspaceViewChoice } from '../../../src/shared/workspace-view/workspace-view-options'
import type { WorktreeCardProperty } from '../../../src/shared/ui-chrome-types'

// Product call: the phone has no port scan, and ports are not worth one; the desktop keeps them.
const PHONE_HIDDEN_CARD_PROPERTIES: ReadonlySet<WorktreeCardProperty> = new Set(['ports'])

/** The shared choices the phone offers, in the shared order. */
export function phoneCardPropertyChoices<Choice extends WorkspaceViewChoice<WorktreeCardProperty>>(
  choices: readonly Choice[]
): Choice[] {
  return choices.filter((choice) => !PHONE_HIDDEN_CARD_PROPERTIES.has(choice.id))
}

/** The shown properties the phone counts, so its count matches the rows it lists. */
export function withoutPhoneHiddenProperties(
  properties: readonly WorktreeCardProperty[]
): WorktreeCardProperty[] {
  return properties.filter((property) => !PHONE_HIDDEN_CARD_PROPERTIES.has(property))
}

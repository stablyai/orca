import { useState } from 'react'
import type { SessionOptionDescriptor } from '../../../../../src/shared/native-chat/input/native-chat-session-options'

/** Legacy models wait behind More models, as compact pickers do without search; shown when the chat is on one of them, then follows the user until reset. */
export function useMoreModelsShown(model: SessionOptionDescriptor | undefined) {
  const [toggled, setToggled] = useState<boolean | null>(null)
  const kind = model?.kind
  const onMoreChoice =
    kind?.type === 'select' &&
    kind.choices.some((choice) => choice.value === kind.currentValue && choice.legacy)
  // Latch it so a pick in the open drawer never collapses rows under the finger.
  if (toggled === null && onMoreChoice) {
    setToggled(true)
  }
  const shown = toggled ?? onMoreChoice
  return { shown, onToggle: () => setToggled(!shown), reset: () => setToggled(null) }
}

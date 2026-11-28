import { labelFromModelId } from '../../../../../../src/shared/agent-session/options/model-catalog/model-id-label'
import type { SessionOptionDescriptor } from '../../../../../../src/shared/native-chat/input/native-chat-session-options'

/**
 * Names the version that actually answered on the model the chat reports, e.g. "Opus 5.5" for
 * the catalog's "Opus". Only the selected choice's label changes: its value, the input selection,
 * stays the catalog id. A model picked on the phone is not 'reported' and keeps its own name.
 */
export function withAnsweringModelLabel(
  descriptor: SessionOptionDescriptor,
  answeringModel: string
): SessionOptionDescriptor {
  if (
    descriptor.category !== 'model' ||
    descriptor.valueSource !== 'reported' ||
    descriptor.kind.type !== 'select' ||
    !descriptor.kind.currentValue
  ) {
    return descriptor
  }
  const current = descriptor.kind.currentValue
  if (current.replace(/\[[^\]]*\]$/u, '') === answeringModel) {
    return descriptor
  }
  const listed = descriptor.kind.choices.find((choice) => choice.value === current)
  const exact = labelFromModelId(answeringModel)
  const label = listed?.label.startsWith('Claude ') ? exact : exact.replace(/^Claude /, '')
  const choices = listed
    ? descriptor.kind.choices.map((choice) => (choice === listed ? { ...choice, label } : choice))
    : [...descriptor.kind.choices, { value: current, label }]
  return { ...descriptor, kind: { ...descriptor.kind, choices } }
}

import {
  isDefaultServiceTier,
  type SessionOptionDescriptor,
  type SessionOptionDisabledReason,
  type SessionOptionSelectChoice
} from '../../../../../src/shared/native-chat/input/native-chat-session-options'

export function mobileSessionOptionDisabledReason(
  reason: SessionOptionDisabledReason | undefined
): string | null {
  switch (reason) {
    case 'set-when-session-starts':
      return 'Set when the session starts.'
    case 'available-after-session-start':
      return 'Available after the session starts.'
    case undefined:
      return null
  }
}

function selectedChoiceLabel(descriptor: SessionOptionDescriptor): string | null {
  if (
    descriptor.valueSource === 'unknown' ||
    descriptor.kind.type !== 'select' ||
    !descriptor.kind.currentValue
  ) {
    return null
  }
  if (descriptor.id === 'permissionMode' && descriptor.description) {
    return descriptor.description
  }
  const current = descriptor.kind.currentValue
  const choice: SessionOptionSelectChoice = descriptor.kind.choices.find(
    (candidate) => candidate.value === current
  ) ?? { value: current, label: current }
  return choice.label
}

/** Value-only pill text — the category lives on the sheet title, not the pill. */
export function mobileModelPillLabel(descriptor: SessionOptionDescriptor): string {
  return selectedChoiceLabel(descriptor) ?? 'Model'
}

export function mobileSessionOptionSummaryValue(descriptor: SessionOptionDescriptor): string {
  // Show the boolean value consistently with its switch; the source marker separately expresses whether it is confirmed.
  if (descriptor.kind.type === 'boolean') {
    return descriptor.kind.currentValue ? 'On' : 'Off'
  }
  if (descriptor.valueSource === 'unknown') {
    return descriptor.id === 'permissionMode' ? 'Permissions' : 'Not set'
  }
  return selectedChoiceLabel(descriptor) ?? 'Not set'
}

export function mobileOptionsPillLabel(descriptors: readonly SessionOptionDescriptor[]): string {
  const labels: string[] = []
  for (const descriptor of descriptors) {
    if (descriptor.valueSource === 'unknown' || isDefaultServiceTier(descriptor)) {
      continue
    }
    if (descriptor.kind.type === 'select') {
      const label = selectedChoiceLabel(descriptor)
      if (label) {
        labels.push(label)
      }
    } else if (descriptor.kind.currentValue === true) {
      labels.push(descriptor.id === 'fastMode' ? 'Fast' : descriptor.label)
    }
  }
  if (labels.length > 0) {
    return labels.join(' · ')
  }
  const effort = descriptors.find((descriptor) => descriptor.id === 'effort')
  return effort ? effort.label : 'Options'
}

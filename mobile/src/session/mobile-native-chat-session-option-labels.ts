import type {
  SessionOptionDescriptor,
  SessionOptionDisabledReason,
  SessionOptionSelectChoice
} from '../../../src/shared/native-chat-session-options'
import { createMobileTranslator } from '@/i18n/mobile-i18n'

const tr = createMobileTranslator('mobileNativeChatSessionOptions')

export function mobileSessionOptionLabel(descriptor: SessionOptionDescriptor): string {
  switch (descriptor.id) {
    case 'model':
      return tr('model')
    case 'effort':
      return tr('effort')
    case 'fastMode':
      return tr('fastMode')
    case 'thinking':
      return tr('thinking')
    default:
      return descriptor.label
  }
}

export function mobileSessionChoiceLabel(choice: SessionOptionSelectChoice): string {
  switch (choice.value) {
    case 'minimal':
      return tr('optionValue.minimal')
    case 'low':
      return tr('optionValue.low')
    case 'medium':
      return tr('optionValue.medium')
    case 'high':
      return tr('optionValue.high')
    case 'xhigh':
      return tr('optionValue.xhigh')
    case 'max':
      return tr('optionValue.max')
    default:
      return choice.label
  }
}

export function mobileSessionOptionDisabledReason(
  reason: SessionOptionDisabledReason | undefined
): string | null {
  // Exhaustive over SessionOptionDisabledReason so new keys are a compile error.
  switch (reason) {
    case 'set-when-session-starts':
      return tr('setWhenSessionStarts')
    case 'available-after-session-start':
      return tr('availableAfterSessionStarts')
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
  const current = descriptor.kind.currentValue
  const choice: SessionOptionSelectChoice = descriptor.kind.choices.find(
    (candidate) => candidate.value === current
  ) ?? { value: current, label: current }
  return mobileSessionChoiceLabel(choice)
}

/** Value-only pill text — the category lives on the sheet title, not the pill. */
export function mobileModelPillLabel(descriptor: SessionOptionDescriptor): string {
  return selectedChoiceLabel(descriptor) ?? tr('model')
}

export function mobileSessionOptionSummaryValue(descriptor: SessionOptionDescriptor): string {
  if (descriptor.valueSource === 'unknown') {
    return tr('notSet')
  }
  if (descriptor.kind.type === 'select') {
    return selectedChoiceLabel(descriptor) ?? tr('notSet')
  }
  return descriptor.kind.currentValue === undefined
    ? tr('notSet')
    : descriptor.kind.currentValue
      ? tr('optionValue.on')
      : tr('optionValue.off')
}

export function mobileOptionsPillLabel(descriptors: readonly SessionOptionDescriptor[]): string {
  const labels: string[] = []
  for (const descriptor of descriptors) {
    if (descriptor.valueSource === 'unknown') {
      continue
    }
    if (descriptor.kind.type === 'select') {
      const label = selectedChoiceLabel(descriptor)
      if (label) {
        labels.push(label)
      }
    } else if (descriptor.kind.currentValue === true) {
      labels.push(
        descriptor.id === 'fastMode' ? tr('optionValue.fast') : mobileSessionOptionLabel(descriptor)
      )
    }
  }
  if (labels.length > 0) {
    return labels.join(' · ')
  }
  const effort = descriptors.find((descriptor) => descriptor.id === 'effort')
  return effort ? mobileSessionOptionLabel(effort) : tr('options')
}

import { translate } from '../../../../i18n/mobile-i18n'
import type {
  SessionOptionDescriptor,
  SessionOptionSelectChoice
} from '../../../../../../src/shared/native-chat/input/native-chat-session-options'
import {
  nativeChatSessionChoiceLabel,
  selectedNativeChatChoice
} from '../../../../../../src/shared/native-chat/input/session-options/native-chat-session-option-labels'
import { sayMobileNativeChatSessionOption as say } from './native-chat-session-option-copy'

export function mobileModelChoiceParts(
  choice: SessionOptionSelectChoice | undefined
): { model: string; provider: string } | null {
  if (!choice) {
    return null
  }
  const separator = ' · '
  const split = choice.label.lastIndexOf(separator)
  if (split < 1) {
    return null
  }
  const model = choice.label.slice(split + separator.length).trim()
  const provider = choice.label.slice(0, split).trim()
  // Only split a catalog label when its suffix identifies the model in its selection value.
  return model &&
    provider &&
    (choice.value === model ||
      choice.value.endsWith(':' + model) ||
      choice.value.endsWith('/' + model))
    ? { model, provider }
    : null
}

/** The value a drill-in row shows beside its label; desktop lists the choices in place instead. */
export function mobileSessionOptionSummaryValue(descriptor: SessionOptionDescriptor): string {
  // Show the boolean value consistently with its switch; the source marker separately expresses whether it is confirmed.
  if (descriptor.kind.type === 'boolean') {
    return descriptor.kind.currentValue
      ? translate('chat.sessionOptionCopy.on', 'On')
      : translate('chat.sessionOptionCopy.off', 'Off')
  }
  if (descriptor.valueSource === 'unknown') {
    return descriptor.id === 'permissionMode'
      ? translate('chat.sessionOptionCopy.permissions', 'Permissions')
      : translate('chat.sessionOptionCopy.notSet', 'Not set')
  }
  if (
    descriptor.id === 'permissionMode' &&
    descriptor.kind.type === 'select' &&
    descriptor.kind.currentValue === 'own'
  ) {
    return translate('settings.agents.permissionOwnAll', "Agents' own settings")
  }
  const choice = selectedNativeChatChoice(descriptor)
  if (!choice) {
    return translate('chat.sessionOptionCopy.notSet', 'Not set')
  }
  if (descriptor.id === 'permissionMode') {
    const deferred = deferredPermissionSummary(descriptor, choice)
    if (deferred) {
      return deferred.compact
    }
  }
  if (descriptor.id === 'permissionMode' && descriptor.description) {
    return descriptor.description
  }
  return nativeChatSessionChoiceLabel(choice, say, descriptor.id)
}

type DeferredPermissionSummary = { saved: string; compact: string; timing: string; full: string }

/** A permission pick saved for the next message while another launch mode runs, in every length mobile shows. */
export function mobileDeferredPermissionSummary(
  descriptor: SessionOptionDescriptor
): DeferredPermissionSummary | null {
  if (descriptor.id !== 'permissionMode' || descriptor.kind.type !== 'select') {
    return null
  }
  const choice = selectedNativeChatChoice(descriptor)
  return choice ? deferredPermissionSummary(descriptor, choice) : null
}

function deferredPermissionSummary(
  descriptor: SessionOptionDescriptor,
  choice: NonNullable<ReturnType<typeof selectedNativeChatChoice>>
): DeferredPermissionSummary | null {
  if (
    descriptor.kind.type !== 'select' ||
    descriptor.valueSource !== 'dispatched' ||
    typeof descriptor.activeValue !== 'string'
  ) {
    return null
  }
  const active = descriptor.kind.choices.find((choice) => choice.value === descriptor.activeValue)
  const activeLabel = active
    ? nativeChatSessionChoiceLabel(active, say, descriptor.id)
    : descriptor.activeValue === 'own'
      ? translate('settings.agents.permissionOwnAll', "Agents' own settings")
      : null
  if (!activeLabel) {
    return null
  }
  const saved = nativeChatSessionChoiceLabel(choice, say, descriptor.id)
  return {
    saved,
    compact: translate(
      'chat.sessionOptionCopy.permissionAppliesNextMessageCompact',
      '{{saved}} · next message',
      { saved }
    ),
    timing: translate(
      'chat.sessionOptionCopy.permissionAppliesNextMessageTiming',
      'Applies next message · running {{active}}',
      { active: activeLabel }
    ),
    full: translate(
      'chat.sessionOptionCopy.permissionAppliesNextMessage',
      '{{saved}} applies to your next message; running {{active}}',
      { saved, active: activeLabel }
    )
  }
}

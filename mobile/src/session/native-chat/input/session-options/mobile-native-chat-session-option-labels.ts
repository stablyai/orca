import type { Translate } from '../../../../i18n/mobile-i18n'
import type { SessionOptionDescriptor } from '../../../../../../src/shared/native-chat/input/native-chat-session-options'
import {
  nativeChatSessionChoiceLabel,
  selectedNativeChatChoice
} from '../../../../../../src/shared/native-chat/input/session-options/native-chat-session-option-labels'
import { mobileNativeChatSessionOptionSay } from './native-chat-session-option-copy'

/** The value a drill-in row shows beside its label; desktop lists the choices in place instead. */
export function mobileSessionOptionSummaryValue(
  descriptor: SessionOptionDescriptor,
  t: Translate
): string {
  // Show the boolean value consistently with its switch; the source marker separately expresses whether it is confirmed.
  if (descriptor.kind.type === 'boolean') {
    return descriptor.kind.currentValue
      ? t('chat.sessionOptionCopy.on', 'On')
      : t('chat.sessionOptionCopy.off', 'Off')
  }
  if (descriptor.valueSource === 'unknown') {
    return descriptor.id === 'permissionMode'
      ? t('chat.sessionOptionCopy.permissions', 'Permissions')
      : t('chat.sessionOptionCopy.notSet', 'Not set')
  }
  if (
    descriptor.id === 'permissionMode' &&
    descriptor.kind.type === 'select' &&
    descriptor.kind.currentValue === 'own'
  ) {
    return t('settings.agents.permissionOwnAll', "Agents' own settings")
  }
  const choice = selectedNativeChatChoice(descriptor)
  if (!choice) {
    return t('chat.sessionOptionCopy.notSet', 'Not set')
  }
  if (descriptor.id === 'permissionMode') {
    const deferred = deferredPermissionSummary(descriptor, choice, t)
    if (deferred) {
      return deferred.compact
    }
  }
  if (descriptor.id === 'permissionMode' && descriptor.description) {
    return descriptor.description
  }
  return nativeChatSessionChoiceLabel(choice, mobileNativeChatSessionOptionSay(t), descriptor.id)
}

type DeferredPermissionSummary = { saved: string; compact: string; timing: string; full: string }

/** A permission pick saved for the next message while another launch mode runs, in every length mobile shows. */
export function mobileDeferredPermissionSummary(
  descriptor: SessionOptionDescriptor,
  t: Translate
): DeferredPermissionSummary | null {
  if (descriptor.id !== 'permissionMode' || descriptor.kind.type !== 'select') {
    return null
  }
  const choice = selectedNativeChatChoice(descriptor)
  return choice ? deferredPermissionSummary(descriptor, choice, t) : null
}

function deferredPermissionSummary(
  descriptor: SessionOptionDescriptor,
  choice: NonNullable<ReturnType<typeof selectedNativeChatChoice>>,
  t: Translate
): DeferredPermissionSummary | null {
  const say = mobileNativeChatSessionOptionSay(t)
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
      ? t('settings.agents.permissionOwnAll', "Agents' own settings")
      : null
  if (!activeLabel) {
    return null
  }
  const saved = nativeChatSessionChoiceLabel(choice, say, descriptor.id)
  return {
    saved,
    compact: t(
      'chat.sessionOptionCopy.permissionAppliesNextMessageCompact',
      '{{saved}} · next message',
      { saved }
    ),
    timing: t(
      'chat.sessionOptionCopy.permissionAppliesNextMessageTiming',
      'Applies next message · running {{active}}',
      { active: activeLabel }
    ),
    full: t(
      'chat.sessionOptionCopy.permissionAppliesNextMessage',
      '{{saved}} applies to your next message; running {{active}}',
      { saved, active: activeLabel }
    )
  }
}

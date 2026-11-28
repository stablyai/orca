import type { Translate } from '../../../../i18n/mobile-i18n'
import type {
  SessionOptionDescriptor,
  SessionOptionSelectChoice
} from '../../../../../../src/shared/native-chat/input/native-chat-session-options'
import {
  nativeChatSessionChoiceLabel,
  selectedNativeChatChoice
} from '../../../../../../src/shared/native-chat/input/session-options/native-chat-session-option-labels'
import { mobileNativeChatSessionOptionSay } from './native-chat-session-option-copy'
import { isAgentChatPermissionMode } from '../../../../../../src/shared/agent-launch/permissions/agent-chat-permission-mode'
import { agentPermissionSettingsSourceName } from '../../../../../../src/shared/agent-launch/permissions/agent-permission-settings-source'
import {
  mobilePermissionModeCopy,
  mobilePermissionModeLabel
} from '../../../../bots/mobile-permission-mode-copy'

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
  const choice = selectedNativeChatChoice(descriptor)
  if (descriptor.id === 'permissionMode' && descriptor.kind.type === 'select' && choice) {
    // A pick waiting for the next message names itself, Own included, over what still runs.
    const deferred = deferredPermissionSummary(descriptor, choice, t)
    if (deferred) {
      return deferred.compact
    }
    if (descriptor.kind.currentValue === 'own') {
      // Name the mode the agent reports running in; until it reports one, name the agent's settings.
      return reportedPermissionLabel(descriptor, t) ?? agentSettingsLabel(descriptor, t)
    }
    if (isAgentChatPermissionMode(choice.value)) {
      return mobilePermissionModeLabel(choice.value, t)
    }
  }
  if (!choice) {
    return t('chat.sessionOptionCopy.notSet', 'Not set')
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
  if (
    descriptor.kind.type !== 'select' ||
    descriptor.valueSource !== 'dispatched' ||
    typeof descriptor.activeValue !== 'string'
  ) {
    return null
  }
  const activeValue = descriptor.activeValue
  const activeLabel = permissionValueLabel(
    descriptor,
    activeValue,
    descriptor.kind.choices.find((candidate) => candidate.value === activeValue),
    t
  )
  if (!activeLabel) {
    return null
  }
  const saved = permissionValueLabel(descriptor, choice.value, choice, t) ?? choice.label
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

/** A choice row's name and description; permission modes use the phone's catalog, not the host's English copy. */
export function mobileSessionOptionChoiceCopy(
  descriptor: SessionOptionDescriptor,
  choice: SessionOptionSelectChoice,
  t: Translate
): { label: string; description?: string } {
  if (descriptor.id === 'permissionMode' && isAgentChatPermissionMode(choice.value)) {
    const agent = descriptor.kind.type === 'select' ? descriptor.kind.settingsAgent : undefined
    return mobilePermissionModeCopy(agent ?? '', choice.value, t)
  }
  return {
    label: nativeChatSessionChoiceLabel(choice, mobileNativeChatSessionOptionSay(t), descriptor.id),
    ...(choice.description ? { description: choice.description } : {})
  }
}

/** A permission value by its name on the phone: a mode, Own as the agent's settings, else the host's label. */
function permissionValueLabel(
  descriptor: SessionOptionDescriptor,
  value: string,
  choice: SessionOptionSelectChoice | undefined,
  t: Translate
): string | null {
  return isAgentChatPermissionMode(value)
    ? mobilePermissionModeLabel(value, t)
    : value === 'own'
      ? agentSettingsLabel(descriptor, t)
      : choice
        ? nativeChatSessionChoiceLabel(choice, mobileNativeChatSessionOptionSay(t), descriptor.id)
        : null
}

/** An Own chat's reported mode by its translated name; null until the agent reports one Orca can name. */
function reportedPermissionLabel(descriptor: SessionOptionDescriptor, t: Translate): string | null {
  if (descriptor.kind.type !== 'select' || descriptor.kind.currentValue !== 'own') {
    return null
  }
  const reported = descriptor.kind.reportedValue
  return isAgentChatPermissionMode(reported)
    ? mobilePermissionModeLabel(reported, t)
    : reported === 'plan'
      ? t('components.native-chat.composer.planMode', 'Plan')
      : null
}

function settingsSourceName(descriptor: SessionOptionDescriptor): string {
  return agentPermissionSettingsSourceName(
    descriptor.kind.type === 'select' ? descriptor.kind.settingsAgent : undefined
  )
}

function agentSettingsLabel(descriptor: SessionOptionDescriptor, t: Translate): string {
  return t('components.native-chat.composer.permissionAgentSettings', '{{agent}} settings', {
    agent: settingsSourceName(descriptor)
  })
}

/** A reported mode is not an explicit pick, so its spoken value says where it comes from. */
export function mobileReportedPermissionAccessibleValue(
  descriptor: SessionOptionDescriptor | undefined,
  t: Translate
): string | undefined {
  const mode = descriptor ? reportedPermissionLabel(descriptor, t) : null
  return mode && descriptor
    ? t(
        'components.native-chat.composer.permissionFromAgentSettings',
        '{{mode}}, from {{agent}} settings',
        {
          mode,
          agent: settingsSourceName(descriptor)
        }
      )
    : undefined
}

/** The mode a chat runs in: Own follows what still runs until the next message, then what the agent reports;
 *  any other choice is its own value. */
export function mobileEffectivePermissionValue(
  descriptor: SessionOptionDescriptor | undefined
): string | undefined {
  if (descriptor?.kind.type !== 'select') {
    return undefined
  }
  const { currentValue, reportedValue } = descriptor.kind
  if (currentValue !== 'own') {
    return currentValue
  }
  // The pending-pick text names the running mode, so the warning follows that mode too.
  if (descriptor.valueSource === 'dispatched' && typeof descriptor.activeValue === 'string') {
    return descriptor.activeValue
  }
  return reportedValue ?? currentValue
}

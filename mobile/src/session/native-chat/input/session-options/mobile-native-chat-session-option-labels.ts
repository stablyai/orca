import { translate } from '../../../../i18n/mobile-i18n'
import type { SessionOptionDescriptor } from '../../../../../../src/shared/native-chat/input/native-chat-session-options'
import {
  nativeChatSessionChoiceLabel,
  selectedNativeChatChoice
} from '../../../../../../src/shared/native-chat/input/session-options/native-chat-session-option-labels'
import { sayMobileNativeChatSessionOption as say } from './native-chat-session-option-copy'
import {
  isAgentChatPermissionMode,
  type AgentChatPermissionMode
} from '../../../../../../src/shared/agent-launch/permissions/agent-chat-permission-mode'
import {
  agentPermissionSettingsHint,
  agentPermissionSettingsSourceName
} from '../../../../../../src/shared/agent-launch/permissions/agent-permission-settings-source'

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
    // Name the mode the agent reports running in; until it reports, name the agent's settings.
    return reportedPermissionLabel(descriptor) ?? mobileAgentSettingsLabel(descriptor)
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
      ? mobileAgentSettingsLabel(descriptor)
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
      'Applies next message · currently using {{active}}',
      { active: activeLabel }
    ),
    full: translate(
      'chat.sessionOptionCopy.permissionAppliesNextMessage',
      '{{saved}} applies to your next message; currently using {{active}}',
      { saved, active: activeLabel }
    )
  }
}

/** An Own chat's reported mode, by its translated name; null until the agent reports one. */
function reportedPermissionLabel(descriptor: SessionOptionDescriptor): string | null {
  if (descriptor.kind.type !== 'select' || descriptor.kind.currentValue !== 'own') {
    return null
  }
  const reported = descriptor.kind.reportedValue
  return isAgentChatPermissionMode(reported)
    ? mobilePermissionModeLabel(reported)
    : reported === 'plan'
      ? translate('components.native-chat.composer.planMode', 'Plan')
      : null
}

function mobileAgentSettingsLabel(descriptor: SessionOptionDescriptor): string {
  return translate(
    'components.native-chat.composer.permissionAgentSettings',
    '{{agent}} settings',
    {
      agent: agentPermissionSettingsSourceName(
        descriptor.kind.type === 'select' ? descriptor.kind.settingsAgent : undefined
      )
    }
  )
}

export function mobilePermissionSettingsHint(
  descriptor: SessionOptionDescriptor | undefined
): string | undefined {
  if (descriptor?.kind.type !== 'select') {
    return undefined
  }
  // Mobile can't tell whether a report is still coming, so a missing one promises nothing.
  const hint = agentPermissionSettingsHint({
    current: descriptor.kind.currentValue,
    reported: descriptor.kind.reportedValue,
    deferred: descriptor.valueSource === 'dispatched'
  })
  if (!hint) {
    return undefined
  }
  const agent = agentPermissionSettingsSourceName(descriptor.kind.settingsAgent)
  return hint === 'unnamed-report'
    ? translate(
        'components.native-chat.composer.permissionAgentSettingsUnnamedHint',
        "Uses your {{agent}} permission settings. Orca can't show this mode.",
        { agent }
      )
    : translate(
        'components.native-chat.composer.permissionAgentSettingsUsedHint',
        'Uses your {{agent}} permission settings.',
        { agent }
      )
}

/** A reported mode is not an explicit pick, so its spoken value says where it comes from. */
export function mobileReportedPermissionAccessibleValue(
  descriptor: SessionOptionDescriptor | undefined
): string | undefined {
  const mode = descriptor ? reportedPermissionLabel(descriptor) : null
  return mode && descriptor
    ? translate(
        'components.native-chat.composer.permissionFromAgentSettings',
        '{{mode}}, from {{agent}} settings',
        {
          mode,
          agent: agentPermissionSettingsSourceName(
            descriptor.kind.type === 'select' ? descriptor.kind.settingsAgent : undefined
          )
        }
      )
    : undefined
}

function mobilePermissionModeLabel(mode: AgentChatPermissionMode): string {
  switch (mode) {
    case 'ask':
      return translate('components.native-chat.composer.permissionAsk', 'Ask for approval')
    case 'accept-edits':
      return translate('components.native-chat.composer.permissionAcceptEdits', 'Accept edits')
    case 'auto':
      return translate('components.native-chat.composer.permissionAuto', 'Approve for me')
    case 'full-access':
      return translate('components.native-chat.composer.permissionFullAccess', 'Full access')
  }
}

/** The mode a chat runs in: Own follows what the agent reports, other choices are their own value. */
export function mobileEffectivePermissionValue(
  descriptor: SessionOptionDescriptor | undefined
): string | undefined {
  if (descriptor?.kind.type !== 'select') {
    return undefined
  }
  const { currentValue, reportedValue } = descriptor.kind
  return currentValue === 'own' && reportedValue !== undefined ? reportedValue : currentValue
}

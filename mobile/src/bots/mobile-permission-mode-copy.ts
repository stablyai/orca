// A chat permission mode's name and what it does, in the phone's language. The keys and English match
// the desktop composer's (native-chat-permission-mode-labels.ts), so both catalogs share translations.
import type { AgentChatPermissionMode } from '../../../src/shared/agent-launch/permissions/agent-chat-permission-mode'
import type { Translate } from '../i18n/mobile-i18n'

export function mobilePermissionModeLabel(mode: AgentChatPermissionMode, t: Translate): string {
  switch (mode) {
    case 'read-only':
      return t('components.native-chat.composer.permissionReadOnly', 'Read-only')
    case 'ask':
      return t('components.native-chat.composer.permissionAsk', 'Ask for approval')
    case 'accept-edits':
      return t('components.native-chat.composer.permissionAcceptEdits', 'Accept edits')
    case 'auto':
      return t('components.native-chat.composer.permissionAuto', 'Approve for me')
    case 'full-access':
      return t('components.native-chat.composer.permissionFullAccess', 'Full access')
  }
}

export function mobilePermissionModeDescription(
  mode: AgentChatPermissionMode,
  agent: string,
  t: Translate
): string {
  switch (mode) {
    case 'read-only':
      return t(
        'components.native-chat.composer.permissionReadOnlyDescription',
        'Uses the agent’s read-only sandbox without approval escalation'
      )
    case 'ask':
      return agent === 'claude'
        ? t(
            'components.native-chat.composer.permissionAskDescription',
            "Asks before edits and commands your settings don't allow"
          )
        : t(
            'components.native-chat.composer.permissionAskSharedDescription',
            "Asks before edits or commands it isn't already allowed to make"
          )
    case 'accept-edits':
      return agent === 'antigravity'
        ? t(
            'components.native-chat.composer.permissionAcceptEditsAntigravityDescription',
            'Approves file edits; asks for the rest'
          )
        : t(
            'components.native-chat.composer.permissionAcceptEditsDescription',
            'Approves file edits and file commands; asks for the rest'
          )
    case 'auto':
      return t(
        'components.native-chat.composer.permissionAutoDescription',
        'Reviews approval requests for you'
      )
    case 'full-access':
      return agent === 'codex'
        ? t(
            'components.native-chat.composer.permissionFullAccessCodexDescription',
            'Never asks; can edit any file and use the network'
          )
        : t(
            'components.native-chat.composer.permissionFullAccessDescription',
            'Never asks before edits or commands'
          )
  }
}

export function mobilePermissionModeCopy(
  agent: string,
  mode: AgentChatPermissionMode,
  t: Translate
): { label: string; description: string } {
  return {
    label: mobilePermissionModeLabel(mode, t),
    description: mobilePermissionModeDescription(mode, agent, t)
  }
}

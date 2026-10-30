import { buildMobileQuickCommandLaunch } from '../terminal/quick-commands'
import type { MobileQuickCommandLaunch } from '../terminal/quick-commands'
import { triggerError } from '../platform/haptics'
import { translate } from '../i18n/mobile-i18n'
import type { TerminalQuickCommand } from '../../../src/shared/terminal-quick-command-types'
import type { MobileNewTabAgentOption } from './mobile-new-tab-agent-options'
import type { MobileSessionAttachmentsModel } from './use-mobile-session-attachments'

export function launchMobileSessionQuickCommand(
  scope: Pick<
    MobileSessionAttachmentsModel,
    | 'client'
    | 'connState'
    | 'creatingTerminalRef'
    | 'creatingBrowser'
    | 'creatingMarkdown'
    | 'showToast'
  >,
  createTerminal: (
    agent?: MobileNewTabAgentOption['agent'],
    options?: MobileQuickCommandLaunch['options'] & { errorToast?: string }
  ) => Promise<unknown>,
  command: TerminalQuickCommand
): boolean {
  if (
    !scope.client ||
    scope.connState !== 'connected' ||
    scope.creatingTerminalRef.current ||
    scope.creatingBrowser ||
    scope.creatingMarkdown
  ) {
    return false
  }
  const launch = buildMobileQuickCommandLaunch(command)
  if (!launch) {
    triggerError()
    scope.showToast(
      translate(
        'session.quickCommandLaunch.editBeforeRunning',
        'Edit this quick command before running it'
      ),
      1800
    )
    return false
  }
  const label =
    command.label.trim() || translate('session.quickCommandLaunch.defaultLabel', 'Quick command')
  void createTerminal(launch.agent, {
    ...launch.options,
    errorToast: translate('session.quickCommandLaunch.runFailed', "Couldn't run {{label}}", {
      label
    })
  })
  return true
}

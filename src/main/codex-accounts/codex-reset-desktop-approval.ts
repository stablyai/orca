import { dialog, type BrowserWindow } from 'electron'
import type { CodexResetCreditExpectedScope } from '../../shared/codex-reset-credit-scope'
import { isBackgroundLaunch } from '../window/foreground-activation-policy'

export async function approveCodexResetOnDesktop(
  scope: CodexResetCreditExpectedScope,
  email: string,
  window: BrowserWindow | null,
  headless: boolean
): Promise<boolean> {
  if (headless || !window || window.isDestroyed() || !window.isVisible() || isBackgroundLaunch()) {
    throw new Error('Codex reset requires approval in a visible Orca desktop session.')
  }
  const result = await dialog.showMessageBox(window, {
    type: 'warning',
    title: 'Approve Codex reset request',
    message: 'Spend one Codex reset credit?',
    detail: [
      `Account: ${email} (${scope.accountId})`,
      `Runtime: ${scope.target.runtime}${scope.target.wslDistro ? ` (${scope.target.wslDistro})` : ''}`,
      'A CLI caller requested a reset of eligible server-side usage windows.',
      'This spends one earned credit. Approve only if you requested this reset.'
    ].join('\n'),
    buttons: ['Cancel', 'Spend one reset credit'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return result.response === 1
}

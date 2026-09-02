import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import type { InstallDirAclPoisonDiagnosis } from '../startup/windows-install-dir-acl-recovery'

/**
 * The dialog shown when the renderer crash-loop breaker opens: the window is
 * blank by then, so this is the only retry/quit surface the user has.
 */

const GENERIC_DETAIL =
  'This is often a graphics-driver or installation problem. Reload to try again, or quit and relaunch Orca.'
// Why keep it alongside the ACL diagnosis: the probe cannot name-check every
// locale, so a driver crash on a healthy install must not lose its only hint.
const DRIVER_FALLBACK = 'If that does not help, the cause is usually a graphics driver.'

export type RendererRecoveryPromptDeps = {
  recentRecoveryCount: number
  isQuitting: () => boolean
  diagnose: () => InstallDirAclPoisonDiagnosis | null
  showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
  copyToClipboard: (text: string) => void
  reload: () => void
  quit: () => void
}

export async function presentRendererRecoveryPrompt(
  deps: RendererRecoveryPromptDeps
): Promise<void> {
  // Why a loop: copying the commands must not dismiss the only surface offering them.
  while (!deps.isQuitting()) {
    const diagnosis = deps.diagnose()
    const buttons = diagnosis ? ['Reload', 'Copy Commands', 'Quit'] : ['Reload', 'Quit']
    const { response } = await deps.showMessageBox({
      type: 'error',
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
      title: 'Orca keeps failing to load',
      message: 'The app window crashed repeatedly and stopped reloading automatically.',
      detail: `Orca tried to recover ${deps.recentRecoveryCount} times in a row without success.\n\n${
        diagnosis ? `${diagnosis.detail}\n\n${DRIVER_FALLBACK}` : GENERIC_DETAIL
      }`
    })
    const choice = buttons[response]
    if (choice === 'Copy Commands' && diagnosis) {
      deps.copyToClipboard(diagnosis.commands.join('\r\n'))
      continue
    }
    if (choice === 'Reload') {
      deps.reload()
    } else if (choice === 'Quit') {
      deps.quit()
    }
    return
  }
}

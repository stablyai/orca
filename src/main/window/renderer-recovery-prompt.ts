import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { translateMain } from '../i18n/main-i18n'
import type { InstallDirAclPoisonDiagnosis } from '../startup/windows-install-dir-acl-recovery'
import type { RecoveryExhaustionCause } from './renderer-recovery-reload-watchdog'

export type RendererRecoveryPromptFailure = RecoveryExhaustionCause

export type RendererRecoveryPromptDeps = {
  recentRecoveryCount: number
  failure?: RendererRecoveryPromptFailure
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
  const stalled = deps.failure === 'reload-stalled'
  // A document that loaded but never ran its JavaScript looks like neither a crash loop nor a
  // stalled load to the user: the window is simply, silently white.
  const blank = deps.failure === 'bootstrap-absent'
  // Copying must preserve the only available recovery surface.
  while (!deps.isQuitting()) {
    const diagnosis = deps.diagnose()
    const buttons = [translateMain('rendererRecovery.reload', 'Reload')]
    if (diagnosis) {
      buttons.push(translateMain('rendererRecovery.copyCommands', 'Copy Commands'))
    }
    buttons.push(translateMain('rendererRecovery.quit', 'Quit'))
    const recoveryDetail = blank
      ? translateMain(
          'rendererRecovery.blankDetail',
          'The window finished loading but Orca never started inside it, and reloading did not help.'
        )
      : stalled
        ? translateMain(
            'rendererRecovery.stalledDetail',
            'Orca reloaded the window after a crash, but it never finished loading.'
          )
        : translateMain(
            'rendererRecovery.crashLoopDetail',
            'Orca tried to recover {{recoveryCount}} times in a row without success.',
            { recoveryCount: deps.recentRecoveryCount }
          )
    const causeDetail = diagnosis
      ? `${diagnosis.detail}\n\n${translateMain(
          'rendererRecovery.driverFallback',
          'If that does not help, the cause is usually a graphics driver.'
        )}`
      : translateMain(
          'rendererRecovery.genericDetail',
          'This is often a graphics-driver or installation problem. Reload to try again, or quit and relaunch Orca.'
        )
    const { response } = await deps.showMessageBox({
      type: 'error',
      buttons,
      defaultId: 0,
      // Escape retries instead of destroying the session.
      cancelId: 0,
      title: translateMain('rendererRecovery.title', 'Orca keeps failing to load'),
      message: blank
        ? translateMain('rendererRecovery.blankMessage', 'The app window opened but stayed blank.')
        : stalled
          ? translateMain(
              'rendererRecovery.stalledMessage',
              'The app window stopped responding while reloading after a crash.'
            )
          : translateMain(
              'rendererRecovery.crashLoopMessage',
              'The app window crashed repeatedly and stopped reloading automatically.'
            ),
      detail: `${recoveryDetail}\n\n${causeDetail}`
    })
    if (response === 1 && diagnosis) {
      deps.copyToClipboard(diagnosis.commands.join('\r\n'))
      continue
    }
    if (response === 0) {
      deps.reload()
    } else if (response === buttons.length - 1) {
      deps.quit()
    }
    return
  }
}

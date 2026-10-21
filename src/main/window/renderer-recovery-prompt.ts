import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'
import { translateMain } from '../i18n/main-i18n'
import type { InstallDirAclPoisonDiagnosis } from '../startup/windows-install-dir-acl-recovery'
import type { RecoveryExhaustionCause } from './renderer-recovery-reload-watchdog'
import type { RendererLaunchProbeResult } from './renderer-launch-failure-probe'

export type RendererRecoveryPromptFailure = RecoveryExhaustionCause

export type RendererRecoveryPromptDeps = {
  recentRecoveryCount: number
  failure?: RendererRecoveryPromptFailure
  /** Shown with failure 'low-commit'. */
  availableCommitMB?: number
  isQuitting: () => boolean
  diagnose: () => InstallDirAclPoisonDiagnosis | null
  /** Re-checks spawn headroom so a launch-failed prompt can name the process limit. */
  probeLaunchCapacity?: () => Promise<RendererLaunchProbeResult>
  showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
  copyToClipboard: (text: string) => void
  reload: () => void
  quit: () => void
}

export async function presentRendererRecoveryPrompt(
  deps: RendererRecoveryPromptDeps
): Promise<void> {
  const stalled = deps.failure === 'reload-stalled'
  const launchFailed = deps.failure === 'launch-failed'
  const lowCommit = deps.failure === 'low-commit'
  if (deps.isQuitting()) {
    return
  }
  // Probed once: Copy Commands re-shows the box and must not spawn again. The loop re-checks quitting after it.
  const launchProbe = launchFailed ? await deps.probeLaunchCapacity?.() : undefined
  // Copying must preserve the only available recovery surface.
  while (!deps.isQuitting()) {
    const diagnosis = lowCommit ? null : deps.diagnose()
    // Why no Restart button: relaunching needs a free process slot too, and app.relaunch fails silently without one.
    const buttons = [
      launchFailed
        ? translateMain('rendererRecovery.tryAgain', 'Try Again')
        : translateMain('rendererRecovery.reload', 'Reload')
    ]
    if (diagnosis) {
      buttons.push(translateMain('rendererRecovery.copyCommands', 'Copy Commands'))
    }
    buttons.push(translateMain('rendererRecovery.quit', 'Quit'))
    const content = launchFailed
      ? describeLaunchFailure(deps.recentRecoveryCount, launchProbe, diagnosis)
      : lowCommit
        ? describeLowCommit(deps.availableCommitMB ?? 0)
        : describeRendererCrash(stalled, deps.recentRecoveryCount, diagnosis)
    const { response } = await deps.showMessageBox({
      type: 'error',
      buttons,
      defaultId: 0,
      // Escape retries instead of destroying the session.
      cancelId: 0,
      title: translateMain('rendererRecovery.title', 'Orca keeps failing to load'),
      ...content
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

type PromptContent = { message: string; detail: string }

function describeLowCommit(availableMB: number): PromptContent {
  const recoveryDetail = translateMain(
    'rendererRecovery.lowCommitDetail',
    'Windows has only {{availableMB}} MB of memory left for apps, so the window ran out of memory again after reloading.',
    { availableMB }
  )
  const advice = translateMain(
    'rendererRecovery.lowCommitAdvice',
    'Free memory by closing unused apps or Orca workspaces, or increase the Windows page file size, then click Reload.'
  )
  return {
    message: translateMain('rendererRecovery.lowCommitMessage', 'Windows is out of memory.'),
    detail: `${recoveryDetail}\n\n${advice}`
  }
}

function describeLaunchFailure(
  attempts: number,
  probe: RendererLaunchProbeResult | undefined,
  diagnosis: InstallDirAclPoisonDiagnosis | null
): PromptContent {
  const message = translateMain(
    'rendererRecovery.launchFailedMessage',
    "Orca couldn't start the process that draws its window."
  )
  const retried = translateMain(
    'rendererRecovery.launchFailedDetail',
    'Orca retried {{recoveryCount}} times without success.',
    { recoveryCount: attempts }
  )
  const cause =
    probe === 'EAGAIN'
      ? translateMain(
          'rendererRecovery.processLimitDetail',
          'The system refused to create a new process because your user account reached its process limit. This is often caused by runaway terminals, dev servers, or agents. Close some of them, then click Try Again.'
        )
      : (diagnosis?.detail ??
        translateMain(
          'rendererRecovery.launchFailedGenericDetail',
          'The system refused to start it. Free up memory or close other apps, then click Try Again. If this keeps happening, reinstall Orca.'
        ))
  return { message, detail: `${retried}\n\n${cause}` }
}

function describeRendererCrash(
  stalled: boolean,
  recoveryCount: number,
  diagnosis: InstallDirAclPoisonDiagnosis | null
): PromptContent {
  const recoveryDetail = stalled
    ? translateMain(
        'rendererRecovery.stalledDetail',
        'Orca reloaded the window after a crash, but it never finished loading.'
      )
    : translateMain(
        'rendererRecovery.crashLoopDetail',
        'Orca tried to recover {{recoveryCount}} times in a row without success.',
        { recoveryCount }
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
  return {
    message: stalled
      ? translateMain(
          'rendererRecovery.stalledMessage',
          'The app window stopped responding while reloading after a crash.'
        )
      : translateMain(
          'rendererRecovery.crashLoopMessage',
          'The app window crashed repeatedly and stopped reloading automatically.'
        ),
    detail: `${recoveryDetail}\n\n${causeDetail}`
  }
}

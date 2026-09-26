import type { MessageBoxOptions, MessageBoxReturnValue } from 'electron'

export type ProfileStateStartupRecoveryDialogDeps = {
  message: string
  recoveryCommand?: string
  showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
  copyToClipboard: (text: string) => void
}

/** Present the only safe desktop recovery action without changing the failed authority. */
export async function presentProfileStateStartupRecoveryDialog(
  deps: ProfileStateStartupRecoveryDialogDeps
): Promise<void> {
  const buttons = deps.recoveryCommand ? ['Copy recovery command', 'Quit'] : ['Quit']
  const detail = deps.recoveryCommand
    ? `${deps.message}\n\nCopy the recovery command, then run it after Orca closes.`
    : `${deps.message}\n\nQuit Orca and resolve the profile-state authority before retrying.`
  const { response } = await deps.showMessageBox({
    type: 'error',
    buttons,
    defaultId: buttons.length - 1,
    cancelId: buttons.length - 1,
    title: 'Orca profile state cannot be opened',
    message: 'Orca cannot safely open this profile.',
    detail
  })
  if (response === 0 && deps.recoveryCommand) {
    deps.copyToClipboard(deps.recoveryCommand)
  }
}

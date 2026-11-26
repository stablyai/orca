import { translate } from '../../../i18n/mobile-i18n'

/** A create whose reply was lost, or whose resend was refused: it may exist, so another could be a second one. */
export function uncertainCreateMessage(inFolder: boolean): string {
  return inFolder
    ? translate(
        'components.newWorkspaceCreateSubmit.uncertainFolderCreate',
        'This worktree may have been created. Check the folder before creating another.'
      )
    : translate(
        'components.newWorkspaceCreateSubmit.uncertainCreate',
        'This workspace may have been created. Check your workspaces before creating another.'
      )
}

/** The folder screen still owns a create for this repository. */
export function folderCreateBusyMessage(): string {
  return translate(
    'components.newWorkspaceCreateSubmit.folderCreateBusy',
    'A worktree in this repository is still being created or checked. It shows in the folder once it lands.'
  )
}

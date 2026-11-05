// cancel stops a download the user walked away from. save resolves false when they dismissed the folder picker.
// Page-facing saver: save streams a workspace file to a user-picked folder on the device.
export type FileSaver = {
  save: (file: { worktreeId: string; relativePath: string }) => Promise<boolean>
  cancel: () => void
}

// A refusal retrying cannot fix (outdated host), so the toast offers no retry.
// Thrown for refusals whose message is already user-facing and retrying cannot fix.
export class FileSaveRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FileSaveRefusedError'
  }
}

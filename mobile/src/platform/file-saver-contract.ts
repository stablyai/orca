// cancel stops a download the user walked away from. save resolves false when they dismissed the folder picker.
export type FileSaver = {
  save: (file: { worktreeId: string; relativePath: string }) => Promise<boolean>
  cancel: () => void
}

// A refusal retrying cannot fix (outdated host), so the toast offers no retry.
export class FileSaveRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FileSaveRefusedError'
  }
}

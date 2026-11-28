// cancel stops a download the user walked away from, so no share sheet opens over the next screen.
export type FileSharer = {
  share: (file: { worktreeId: string; relativePath: string }) => Promise<void>
  cancel: () => void
}

// A refusal retrying cannot fix (too large, outdated host), with copy the page can show as is.
export class FileShareRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FileShareRefusedError'
  }
}

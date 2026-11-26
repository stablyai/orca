// cancel stops a download the user walked away from, so no viewer opens over the next screen.
export type PdfOpener = {
  open: (file: { worktreeId: string; relativePath: string }) => Promise<void>
  cancel: () => void
}

// A refusal retrying cannot fix (no PDF app, outdated host), so the preview offers no Retry.
export class PdfOpenRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PdfOpenRefusedError'
  }
}

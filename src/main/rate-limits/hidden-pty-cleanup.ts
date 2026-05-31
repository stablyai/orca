type HiddenPty = {
  kill: (signal?: string) => void
  destroy?: () => void
}

type Disposable = {
  dispose: () => void
}

export function cleanupHiddenRateLimitPty(
  term: HiddenPty,
  disposables: Disposable[],
  options: { kill: boolean }
): void {
  for (const disposable of disposables.splice(0)) {
    disposable.dispose()
  }

  if (options.kill) {
    try {
      term.kill()
    } catch {
      /* already exited */
    }

    // Why: node-pty WindowsTerminal.destroy() calls kill() again, which can
    // close the same ConPTY handle twice after an intentional termination.
    if (process.platform === 'win32') {
      return
    }
  }

  // Why: node-pty destroy releases the master PTY fd; on POSIX, neutralize
  // the post-close SIGHUP hook after exit/kill to avoid pid reuse.
  if (process.platform !== 'win32') {
    term.kill = () => {}
  }
  try {
    term.destroy?.()
  } catch {
    /* already torn down */
  }
}

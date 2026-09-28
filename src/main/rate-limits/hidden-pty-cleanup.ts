type HiddenPty = {
  kill: (signal?: string) => void
  destroy?: () => void
}

type Disposable = {
  dispose: () => void
}

const activeHiddenRateLimitPtys = new Set<HiddenPty>()

export function registerHiddenRateLimitPty(term: HiddenPty): Disposable {
  activeHiddenRateLimitPtys.add(term)
  return {
    dispose: () => {
      activeHiddenRateLimitPtys.delete(term)
    }
  }
}

export function getActiveHiddenRateLimitPtyCount(): number {
  return activeHiddenRateLimitPtys.size
}

export function cleanupHiddenRateLimitPty(
  term: HiddenPty,
  disposables: Disposable[],
  options: { kill: boolean }
): void {
  for (const disposable of disposables.splice(0)) {
    disposable.dispose()
  }

  try {
    if (options.kill) {
      term.kill()
    } else {
      term.destroy?.()
    }
  } catch {
    /* already torn down */
  }
}

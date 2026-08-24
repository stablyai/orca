export type TerminalScreenKind = 'alternate' | 'normal' | 'unknown'

/** Whether a mobile resize should replay the full scrollback snapshot.
 *
 *  Alternate-screen TUIs own their repaint. An unknown screen is treated the
 *  same: a provider-preferred suffix can miss the 1049h that entered alt
 *  screen, and restreaming that as shell history remounts the TUI. */
export function shouldRestreamMobileResizeScrollback(args: {
  reason: string
  screen: TerminalScreenKind
}): boolean {
  return args.reason === 'apply-layout' && args.screen === 'normal'
}

/** Classify alt-screen from the same evidence isTerminalAlternateScreen uses.
 *  Missing tracker on a provider-preferred PTY is unknown, not "normal". */
export function resolveTerminalScreenKind(args: {
  providerSnapshotPreferred: boolean
  trackedAlternateScreen?: boolean
  headlessAlternateScreen?: boolean
}): TerminalScreenKind {
  if (args.trackedAlternateScreen === true) {
    return 'alternate'
  }
  if (args.trackedAlternateScreen === false) {
    return 'normal'
  }
  // Why: a live 1049l must beat a stale headless true; only consult headless
  // when the provider tracker has not spoken.
  if (args.headlessAlternateScreen === true) {
    return 'alternate'
  }
  if (args.providerSnapshotPreferred) {
    return 'unknown'
  }
  if (args.headlessAlternateScreen === false) {
    return 'normal'
  }
  return 'unknown'
}

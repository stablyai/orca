// Why: the runtime answers a selector that matches several rows (two projects both named `app`)
// with a bare `selector_ambiguous`, naming neither the value nor a way out. Only the CLI still
// knows which flag the caller typed, so it says which selector was ambiguous and what is exact.

export type SelectorAmbiguityRecovery = {
  ambiguousSelectors: { flag: string; selector: string }[]
  nextSteps: readonly string[]
}

const EXACT_FORMS = {
  repo: {
    // Why the --project route: a local and an SSH project can share both repo id and path.
    forms:
      'id:<repo-id> or path:<absolute-path>; if two hosts share that id or path, use --project <id> --host <host> where the command takes them',
    list: 'orca repo list --json',
    noun: 'project'
  },
  worktree: {
    // Why identity first: a local and an SSH checkout can share both repo id and path.
    forms:
      'identity:<identity.key> (host-qualified), or id:<repo-id>::<absolute-path> when only one host has that checkout',
    list: 'orca worktree list --json',
    noun: 'workspace'
  }
} as const

export function selectorAmbiguityRecovery(selectors: {
  repo?: string
  worktree?: string
  /** The command chose a paired server, so the listing must ask that server, not this machine. */
  remoteServerSelected?: boolean
}): SelectorAmbiguityRecovery | undefined {
  const entries = (['worktree', 'repo'] as const).flatMap((flag) => {
    const selector = selectors[flag]
    return selector ? [{ flag, selector }] : []
  })
  if (entries.length === 0) {
    return undefined
  }
  return {
    ambiguousSelectors: entries.map(({ flag, selector }) => ({ flag: `--${flag}`, selector })),
    nextSteps: entries.flatMap(({ flag, selector }) => {
      const exact = EXACT_FORMS[flag]
      // Both flags given: the runtime does not say which one matched several rows.
      const matched =
        entries.length > 1
          ? `--${flag} "${selector}" may match more than one ${exact.noun}.`
          : `More than one ${exact.noun} matches --${flag} "${selector}".`
      return [
        `${matched} Pass an exact selector: ${exact.forms}.`,
        selectors.remoteServerSelected
          ? `List the exact values with \`${exact.list}\`, passing the same server flag (--environment, --pairing-code or --host runtime:<id>) as this command.`
          : `List the exact values with \`${exact.list}\`.`
      ]
    })
  }
}

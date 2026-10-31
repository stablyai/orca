// The runtime omits the typed selector from ambiguity errors; only the CLI can supply it.

export type SelectorAmbiguityRecovery = {
  ambiguousSelectors: { flag: string; selector: string }[]
  nextSteps: readonly string[]
}

const EXACT_FORMS = {
  repo: {
    forms:
      'id:<repo-id> or path:<absolute-path>; if two hosts share that id or path, use --project <id> --host <host> where the command takes them',
    list: 'orca repo list --json',
    noun: 'project'
  },
  worktree: {
    forms:
      'identity:<identity.key> (host-qualified), or id:<repo-id>::<absolute-path> when only one host has that checkout',
    list: 'orca worktree list --json',
    noun: 'workspace'
  }
} as const

export function selectorAmbiguityRecovery(selectors: {
  repo?: string
  worktree?: string
  /** Route recovery listings to the selected server. */
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

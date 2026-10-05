export type ResolvedFlagHelp = {
  label: string
  description?: string
}

/** Splits one option row into label and description; spec-level help wins over the shared tables. */
export function resolveFlagHelp(
  flag: string,
  specHelp: string | undefined,
  sharedHelp: string
): ResolvedFlagHelp {
  if (specHelp) {
    const valueMatch = /^(<[^>]+>)\s+(.+)$/.exec(specHelp)
    return valueMatch
      ? { label: `--${flag} ${valueMatch[1]}`, description: valueMatch[2] }
      : { label: `--${flag}`, description: specHelp }
  }

  const paddedMatch = /^(.+?)\s{2,}(\S.*)$/.exec(sharedHelp)
  if (paddedMatch) {
    return { label: paddedMatch[1], description: paddedMatch[2] }
  }

  // Unpadded shared entries: a value spec is bracketed or alternation-separated, never prose.
  const singleSpaceMatch = /^(--[A-Za-z0-9-]+(?: (?:<[^>]+>|\S*\|\S*))?) (\S.*)$/.exec(sharedHelp)
  return singleSpaceMatch
    ? { label: singleSpaceMatch[1], description: singleSpaceMatch[2] }
    : { label: sharedHelp }
}

/** Renders option rows with every description starting in one column. */
export function formatFlagHelpRows(rows: readonly ResolvedFlagHelp[]): string[] {
  const descriptionColumn =
    Math.max(0, ...rows.filter((row) => row.description).map((row) => row.label.length)) + 2
  return rows.map(({ label, description }) =>
    description ? `  ${label.padEnd(descriptionColumn)}${description}` : `  ${label}`
  )
}

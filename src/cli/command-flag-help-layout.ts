export type ResolvedFlagHelp = {
  label: string
  description?: string
}

export function resolveFlagHelp(
  flag: string,
  commandHelp: string | undefined,
  legacyHelp: string
): ResolvedFlagHelp {
  if (commandHelp) {
    const valueMatch = /^(<[^>]+>)\s+(.+)$/.exec(commandHelp)
    return valueMatch
      ? { label: `--${flag} ${valueMatch[1]}`, description: valueMatch[2] }
      : { label: `--${flag}`, description: commandHelp }
  }

  const paddedMatch = /^(.+?)\s{2,}(\S.*)$/.exec(legacyHelp)
  if (paddedMatch) {
    return { label: paddedMatch[1], description: paddedMatch[2] }
  }

  // Unpadded legacy entries: a value spec is bracketed or alternation-separated, never prose.
  const singleSpaceMatch = /^(--[A-Za-z0-9-]+(?: (?:<[^>]+>|\S*\|\S*))?) (\S.*)$/.exec(legacyHelp)
  return singleSpaceMatch
    ? { label: singleSpaceMatch[1], description: singleSpaceMatch[2] }
    : { label: legacyHelp }
}

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

  const legacyMatch = /^(.+?)\s{2,}(\S.*)$/.exec(legacyHelp)
  return legacyMatch
    ? { label: legacyMatch[1], description: legacyMatch[2] }
    : { label: legacyHelp }
}

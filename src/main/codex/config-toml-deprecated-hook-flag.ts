export function normalizeDeprecatedCodexHookFeatureFlag(config: string): string {
  if (!config.includes('codex_hooks')) {
    return config
  }

  const lines = config.split('\n')
  const featureSections: { start: number; end: number }[] = []
  let featureStart: number | null = null

  for (let index = 0; index <= lines.length; index += 1) {
    const line = lines[index]
    // Why: CRLF configs keep a trailing \r after the split, so header anchors
    // must tolerate it or Windows-shaped configs skip normalization entirely.
    const isHeader = line === undefined || /^[ \t]*\[[^\]]+\][ \t]*(?:#.*)?\r?$/.test(line)
    if (!isHeader) {
      continue
    }

    if (featureStart !== null) {
      featureSections.push({ start: featureStart, end: index })
      featureStart = null
    }
    if (line !== undefined && /^[ \t]*\[features\][ \t]*(?:#.*)?\r?$/.test(line)) {
      featureStart = index
    }
  }

  for (const section of featureSections.toReversed()) {
    normalizeFeatureSectionLines(lines, section.start + 1, section.end)
  }
  return lines.join('\n')
}

function normalizeFeatureSectionLines(lines: string[], start: number, end: number): void {
  const deprecatedIndexes: number[] = []
  let hasHooksKey = false
  for (let index = start; index < end; index += 1) {
    const line = lines[index] ?? ''
    if (/^[ \t]*hooks[ \t]*=/.test(line)) {
      hasHooksKey = true
    }
    if (/^[ \t]*codex_hooks[ \t]*=/.test(line)) {
      deprecatedIndexes.push(index)
    }
  }
  if (deprecatedIndexes.length === 0) {
    return
  }

  if (!hasHooksKey) {
    const firstDeprecatedIndex = deprecatedIndexes.shift()
    if (firstDeprecatedIndex !== undefined) {
      // Why: Codex 0.133 warns on the old key. Mirror into Orca's runtime
      // config using the new key without rewriting the user's real config.
      lines[firstDeprecatedIndex] = lines[firstDeprecatedIndex]!.replace(
        /^([ \t]*)codex_hooks([ \t]*=)/,
        '$1hooks$2'
      )
    }
  }

  for (const index of deprecatedIndexes.toReversed()) {
    lines.splice(index, 1)
  }
}

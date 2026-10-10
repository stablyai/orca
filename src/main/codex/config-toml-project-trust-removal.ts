import {
  getTrustTableKind,
  isOrcaWrittenTable,
  readTomlTables
} from './config-toml-project-duplicate-repair'

export type ProjectTrustRemoval = {
  content: string
  /** Decoded `[projects."<path>"]` keys whose tables were removed. */
  removedPaths: string[]
}

/**
 * Removes `[projects."<path>"]` tables that still hold exactly what Orca's
 * pre-trust wrote, for every path `shouldRemove` accepts. A table the user or
 * Codex edited since (another key, `untrusted`, a different spelling) stays.
 */
export function removeOrcaWrittenProjectTrustTables(
  content: string,
  shouldRemove: (projectPath: string) => boolean
): ProjectTrustRemoval {
  const lines = content.split('\n')
  const removedLines = new Set<number>()
  const removedPaths: string[] = []
  for (const table of readTomlTables(lines)) {
    const projectPath = table.segments?.[1]
    if (
      getTrustTableKind(table) !== 'project' ||
      projectPath === undefined ||
      !shouldRemove(projectPath) ||
      !isOrcaWrittenTable(lines, table)
    ) {
      continue
    }
    for (let index = table.headerLine; index < table.endLine; index += 1) {
      removedLines.add(index)
    }
    removedPaths.push(projectPath)
  }
  if (removedLines.size === 0) {
    return { content, removedPaths }
  }
  const kept = lines.filter((_, index) => !removedLines.has(index))
  if (removedLines.has(lines.length - 1)) {
    // Why: a removed last table leaves the blank separator Orca added before it.
    while (kept.length > 0 && kept.at(-1)?.trim() === '') {
      kept.pop()
    }
    if (kept.length > 0) {
      kept.push('')
    }
  }
  return {
    content: kept.join('\n'),
    removedPaths
  }
}

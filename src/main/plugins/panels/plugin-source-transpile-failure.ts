// No transpiler imports: main formats failures without loading sucrase.

/** Sucrase reports `Error transforming <file>: <reason> (<line>:<column>)`. */
export function parsePluginTranspileFailure(
  relativePath: string,
  message: string
): { message: string; at?: { line: number; column: number } } {
  const reason = message.replace(`Error transforming ${relativePath}: `, '')
  const match = /^(.*) \((\d+):(\d+)\)$/s.exec(reason)
  return match?.[1]
    ? { message: match[1], at: { line: Number(match[2]), column: Number(match[3]) } }
    : { message: reason }
}

/** `<file>:<line>:<column>: <reason>`, the one shape frames, tests and `orca plugin check` show. */
export function formatPluginTranspileFailure(relativePath: string, message: string): string {
  const failure = parsePluginTranspileFailure(relativePath, message)
  const where = failure.at
    ? `${relativePath}:${failure.at.line}:${failure.at.column}`
    : relativePath
  return `${where}: ${failure.message}`
}

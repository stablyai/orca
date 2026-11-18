/** The plain-JSON object in `OPENCODE_CONFIG_CONTENT`; null for JSONC, malformed or non-object
 *  content, which a rewrite would lose. Empty content is an empty config. */
export function readOpenCodeInlineConfig(
  content: string | undefined
): Record<string, unknown> | null {
  let config: unknown
  try {
    config = content?.trim() ? JSON.parse(content) : {}
  } catch {
    return null
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return null
  }
  return { ...config }
}

/** Appends `file` to the inline `instructions`, after any the user listed; null when that cannot be
 *  done without losing their configuration. */
export function withOpenCodeInstructionsFile(
  content: string | undefined,
  file: string
): string | null {
  const config = readOpenCodeInlineConfig(content)
  const listed = config?.instructions
  if (!config || (listed !== undefined && !Array.isArray(listed))) {
    return null
  }
  return JSON.stringify({ ...config, instructions: [...(listed ?? []), file] })
}

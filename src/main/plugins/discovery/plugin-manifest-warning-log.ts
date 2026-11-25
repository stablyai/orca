// Why bounded: one entry per plugin folder seen; old versions' folders stop being read.
const LOGGED_FOLDER_LIMIT = 512

/** Logs manifest warnings once per plugin folder, again only when they change. Why: discovery
 *  re-reads every manifest on each plugin-list refresh, which repeated the same warnings. */
export function createPluginManifestWarningLog(
  warn: (message: string) => void = (message) => console.warn(message)
): (rootDir: string, pluginKey: string, warnings: readonly string[]) => void {
  const logged = new Map<string, string>()
  return (rootDir, pluginKey, warnings) => {
    const unique = [...new Set(warnings)]
    const signature = `${pluginKey}\0${unique.join('\0')}`
    if (unique.length === 0) {
      logged.delete(rootDir)
      return
    }
    if (logged.get(rootDir) === signature) {
      return
    }
    logged.delete(rootDir)
    if (logged.size >= LOGGED_FOLDER_LIMIT) {
      const oldest = logged.keys().next()
      if (!oldest.done) {
        logged.delete(oldest.value)
      }
    }
    logged.set(rootDir, signature)
    for (const warning of unique) {
      warn(`[plugins] ${pluginKey}: ${warning}`)
    }
  }
}

export const logPluginManifestWarnings = createPluginManifestWarningLog()

// Minimal shape shared by every merge source; deliberately not the app's DetectedBrowser.
export type DetectedBrowserLike = {
  family: string
  label: string
  dataDir: string
}

// Why: dedup is per data root, so fold trailing separators and case before comparing.
function normalizeDataDir(dataDir: string): string {
  return dataDir.replace(/[/\\]+$/, '').toLowerCase()
}

// Precedence hardcoded > persistedCustom > discovered on a canonical dataDir key.
// Earlier sources claim the key first; the survivor keeps its own family/label.
export function mergeDetectedBrowsers<T extends DetectedBrowserLike>(
  hardcoded: T[],
  persistedCustom: T[],
  discovered: T[],
  opts: { canonicalize?: (dataDir: string) => string } = {}
): T[] {
  const canonicalize = opts.canonicalize ?? ((dataDir: string) => dataDir)
  const byKey = new Map<string, T>()
  for (const browser of [...hardcoded, ...persistedCustom, ...discovered]) {
    const key = normalizeDataDir(canonicalize(browser.dataDir))
    if (!byKey.has(key)) {
      byKey.set(key, browser)
    }
  }
  return [...byKey.values()]
}

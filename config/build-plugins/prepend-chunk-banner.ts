// Why structural: the parts of Rolldown's OutputChunk and OutputBundle this reads and writes.
type BannerChunk = { code: string; fileName: string; sourcemapFileName?: string | null }
type BundleEntries = Record<string, { type: string; source?: unknown }>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function countLines(text: string): number {
  let lines = 0
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    lines++
  }
  return lines
}

/**
 * Prepends `banner` to a chunk in `generateBundle`, and moves the chunk's source map down to match.
 *
 * Why the map: Rolldown has already emitted each chunk's `.map` asset by `generateBundle`, so a
 * bare `chunk.code = banner + chunk.code` leaves every mapping the banner's line count too high,
 * and crash traces decoded through it name the wrong source line.
 */
export function prependChunkBanner(
  bundle: BundleEntries,
  chunk: BannerChunk,
  banner: string
): void {
  // Why: a banner that ends mid-line would shift the chunk's first line by columns too.
  if (!banner.endsWith('\n')) {
    throw new Error(`${chunk.fileName}: a prepended banner must end with a newline`)
  }
  chunk.code = banner + chunk.code
  const mapAsset = chunk.sourcemapFileName ? bundle[chunk.sourcemapFileName] : undefined
  if (mapAsset?.type !== 'asset' || typeof mapAsset.source !== 'string') {
    return
  }
  const map: unknown = JSON.parse(mapAsset.source)
  if (isRecord(map) && typeof map.mappings === 'string') {
    // Why ';' per line: each one is an empty generated line, so every segment after it moves down.
    map.mappings = ';'.repeat(countLines(banner)) + map.mappings
    mapAsset.source = JSON.stringify(map)
  }
}

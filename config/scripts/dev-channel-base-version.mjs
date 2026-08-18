const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

function parseVersionTriple(value) {
  const match = SEMVER.exec(String(value ?? '').trim())
  if (!match) {
    return null
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null
  }
}

function compareTriples(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

/**
 * The base `X.Y.Z` an hourly or adhoc build should carry.
 *
 * Why not package.json alone: main's version only moves on `release:` commits, and
 * stable patches are cut from release branches that never merge back. On
 * 2026-08-03 main read `1.4.165-rc.0` for twenty hours while 1.4.165, 1.4.166 and
 * 1.4.167 all shipped — so hourlies built from that main claimed 1.4.165 while
 * carrying code newer than 1.4.167, and sorted *below* the stable their user was
 * already running. Published tags are the only honest answer to "what number is
 * taken"; package.json is a floor, not a source of truth.
 */
export function resolveDevChannelBaseVersion(packageVersion, publishedVersions = []) {
  const fromPackage = parseVersionTriple(packageVersion)
  if (!fromPackage) {
    throw new Error(`Package version is not valid semver: ${packageVersion}`)
  }

  // Unparseable tags are skipped rather than fatal: the main repo carries old tags
  // that predate the current scheme, and one of them must not fail every build.
  const published = publishedVersions.map(parseVersionTriple).filter(Boolean)

  let base = fromPackage
  if (published.length > 0) {
    const highest = published.reduce((best, entry) =>
      compareTriples(entry, best) > 0 ? entry : best
    )
    // A shipped stable owns its number, so the next dev build belongs on the patch
    // above it. A bare prerelease does not — rc.1 of 1.4.168 means 1.4.168 is still
    // the version being worked toward, which is exactly what main is building.
    const shipped = published.some(
      (entry) => !entry.prerelease && compareTriples(entry, highest) === 0
    )
    const next = shipped ? { ...highest, patch: highest.patch + 1 } : highest
    if (compareTriples(next, base) > 0) {
      base = next
    }
  }

  return `${base.major}.${base.minor}.${base.patch}`
}

/** Tag list the workflow reads out of the main repo, newline separated. */
export function readPublishedVersionsFromEnv(value = process.env.ORCA_PUBLISHED_VERSIONS) {
  return String(value ?? '')
    .split(/\s+/)
    .filter(Boolean)
}

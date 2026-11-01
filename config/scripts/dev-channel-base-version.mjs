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

// package.json is only a floor: release-branch stable patches do not merge to main, whose stale RC once made hourlies sort below installed stable.
// Git tags reserve numbers even after GitHub releases are unpublished; channel tags also prevent version rollback after unpublish.
export function resolveDevChannelBaseVersion(packageVersion, publishedVersions = []) {
  const fromPackage = parseVersionTriple(packageVersion)
  if (!fromPackage) {
    throw new Error(`Package version is not valid semver: ${packageVersion}`)
  }

  // Skip legacy unparseable tags so one cannot break every build.
  const published = publishedVersions.map(parseVersionTriple).filter(Boolean)

  let base = fromPackage
  if (published.length > 0) {
    const highest = published.reduce((best, entry) =>
      compareTriples(entry, best) > 0 ? entry : best
    )
    // A stable spends its version, requiring next patch; RC still targets the same patch.
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

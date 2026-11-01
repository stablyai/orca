// Derive families from route call-site closure; existing golden tables detect new goldens in known families but miss newly reachable families.

// Convert mobile-relative closure paths (including ../src/shared/) to repo-relative scenario call-site paths.
export function repoRelativeClosurePath(closurePath) {
  return closurePath.startsWith('../') ? closurePath.slice(3) : `mobile/${closurePath}`
}

// Exclude mobileWeb.* shell families: native route closure reaches shell through files replaced by web siblings.
export function pageClosureFamilies(closureLocalPaths, scenarios) {
  const inClosure = new Set(closureLocalPaths.map(repoRelativeClosurePath))
  const families = new Set()
  for (const scenario of scenarios) {
    if ((scenario.sites ?? []).some((site) => inClosure.has(site))) {
      families.add(scenario.family)
    }
  }
  return [...families].filter((family) => !family.startsWith('mobileWeb.')).sort()
}

// Read only TS table keys as text from plain ESM; callers assert nonempty reads to catch parser drift.
export function pinnedFamilyNames(source) {
  return [...source.matchAll(/^ {2}'([^']+)': \{$/gm)].map((match) => match[1])
}

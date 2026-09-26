/**
 * Which golden families a mobile web page's route closure reaches, derived rather than pinned.
 *
 * `c1-page-closure.ts` and the two C2 halves pin, golden by golden, what each family did at the
 * bridge. None of them re-derives the closure: their drift reader walks the families already in the
 * table, so a golden arriving in a pinned family is caught while a family newly *entering* the
 * closure — a scenario recorded at a call site the route has started importing — is invisible until
 * somebody re-derives by hand. This is the presence precondition those tables are missing.
 */

/**
 * A closure module path as the corpus spells its call sites.
 *
 * `mobileWebAppRouteClosure` reports paths relative to `mobile/`, and a module outside it comes back
 * as `../src/shared/…`; scenario `sites` are relative to the repository root throughout.
 */
export function repoRelativeClosurePath(closurePath) {
  return closurePath.startsWith('../') ? closurePath.slice(3) : `mobile/${closurePath}`
}

/**
 * Every family whose scenario names a call site inside the closure, less the shell's own.
 *
 * `mobileWeb.*` is dropped for the reason each pin file's docstring gives: measured from a route's
 * native switch rather than its `.web.tsx` sibling the closure reaches the shell, and the shell's
 * families belong to the shell.
 */
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

/**
 * The family names a pin table commits, read from its source text.
 *
 * Text rather than an import: these are TypeScript modules and this package runs as plain ESM, and
 * only the keys are wanted. A count assertion at each call site is what says the read found a table
 * rather than nothing.
 */
export function pinnedFamilyNames(source) {
  return [...source.matchAll(/^ {2}'([^']+)': \{$/gm)].map((match) => match[1])
}

/**
 * The external-link seam, and how a census recognises a module that went around it.
 *
 * Shared by every page route's census rather than restated in each: two spellings of one rule
 * drift, and the half that stops being enforced is the half nobody reads again.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The seam, as the web build resolves it: `.web.ts` wins under the builder's resolveExtensions,
 *  and it is the one module a page closure may reach react-native's `Linking` from. */
export const EXTERNAL_LINK_SEAM = 'src/platform/external-link.web.ts'

/** 1-based line of a character offset, so an offender is reported where it is written. */
function lineOf(source, index) {
  return source.slice(0, index).split('\n').length
}

/**
 * Every line on which a module reaches react-native's own `Linking`, by name or through a
 * namespace import.
 *
 * Both quote styles: the tree is single-quoted by the formatter today, so a double-quoted
 * specifier would have walked past this unseen — and a census that cannot see a call site is one
 * that passes for the wrong reason.
 *
 * Lines rather than a boolean because a red census that names `path:line` is read once, and one
 * that names a file is grepped for. The boolean below is derived from this, so there is one rule.
 */
export function reactNativeLinkingSites(source) {
  const sites = []
  for (const match of source.matchAll(
    /import\s*\{[^}]*\bLinking\b[^}]*\}\s*from\s*['"]react-native['"]/gs
  )) {
    sites.push(lineOf(source, match.index))
  }
  // Every alias, not the first: a module may import the namespace twice, and reading only the
  // first binding makes a call on the second report no site at all.
  const aliases = [
    ...source.matchAll(/import\s*\*\s*as\s*(\w+)\s*from\s*['"]react-native['"]/g)
  ].map((match) => match[1])
  if (aliases.length > 0) {
    source.split('\n').forEach((line, index) => {
      // Once per line however many aliases meet on it: the line is the site, not the name.
      if (aliases.some((alias) => line.includes(`${alias}.Linking`))) {
        sites.push(index + 1)
      }
    })
  }
  return [...new Set(sites)].sort((left, right) => left - right)
}

/** Whether a module reaches react-native's own `Linking`. */
export function reachesReactNativeLinking(source) {
  return reactNativeLinkingSites(source).length > 0
}

/**
 * Every module in a route's closure that can reach a URL without the seam, as `path:line`.
 *
 * The line is where the name enters the module, not where it is used: a named import is reported
 * once however many times the module calls `Linking.openURL`, because the import is what the rule
 * is about and what has to go. Only a namespace import reports its uses, there being no single
 * line to name — `import * as RN from 'react-native'` is not itself an offence.
 *
 * Here rather than beside each census: three copies of this walk existed before the source-control
 * routes wanted a fourth, and the seam's own module is where the rule they share belongs. A file
 * the closure names but this checkout cannot read is not an offender — the closure reports paths
 * relative to `mobile/`, and one outside it is read by its caller, not guessed at here.
 */
export function externalLinkOffenders(mobileDir, closure) {
  return (
    closure.local
      .filter((file) => file !== EXTERNAL_LINK_SEAM)
      .flatMap((file) => {
        let source
        try {
          source = readFileSync(join(mobileDir, file), 'utf8')
        } catch {
          return []
        }
        return reactNativeLinkingSites(source).map((line) => [file, line])
      })
      // By path, then by line as a number: sorting the rendered strings puts `:10` before `:2`, and
      // a red list is read top to bottom against the file it names.
      .sort(([leftFile, leftLine], [rightFile, rightLine]) =>
        leftFile === rightFile ? leftLine - rightLine : leftFile < rightFile ? -1 : 1
      )
      .map(([file, line]) => `${file}:${line}`)
  )
}

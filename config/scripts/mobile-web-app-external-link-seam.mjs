/**
 * The external-link seam, and how a census recognises a module that went around it.
 *
 * Shared by every page route's census rather than restated in each: two spellings of one rule
 * drift, and the half that stops being enforced is the half nobody reads again.
 */

/** The seam, as the web build resolves it: `.web.ts` wins under the builder's resolveExtensions,
 *  and it is the one module a page closure may reach react-native's `Linking` from. */
export const EXTERNAL_LINK_SEAM = 'src/platform/external-link.web.ts'

/** Whether a module reaches react-native's own `Linking`, by name or through a namespace import. */
export function reachesReactNativeLinking(source) {
  const named = /import\s*\{[^}]*\bLinking\b[^}]*\}\s*from\s*'react-native'/s
  const namespace = /import\s*\*\s*as\s*(\w+)\s*from\s*'react-native'/
  const asNamespace = namespace.exec(source)
  return (
    named.test(source) || (asNamespace !== null && source.includes(`${asNamespace[1]}.Linking`))
  )
}

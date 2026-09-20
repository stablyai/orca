import { describe, expect, it } from 'vitest'
import {
  callsRouteHandoff,
  expoRouterValueImports,
  parse,
  productFiles
} from '../navigation/router-seam-census.test-support'

const SESSION_ROOT = import.meta.dirname

/**
 * Which modules here hold a router, so the census cannot pass by seeing nothing.
 *
 * Three, and each for a different target. The foundation hook bounces a deleted workspace back to
 * its host; the file-tap handlers push a preview route from a terminal link or a chat path; the
 * notification hook consumes a pane tap by rewriting this route's own params. Only the first two
 * can leave the page, which is the whole reason the third is in the list anyway — a `setParams` on
 * expo-router's router and a `setParams` on the handoff's are the same call, and listing it here is
 * what stops someone later giving it back its own `useRouter` because "it never navigates".
 */
const ROUTER_HOLDERS = [
  'use-mobile-file-tap-handlers.ts',
  'use-mobile-session-foundation.ts',
  'use-notification-pane-navigation.ts'
]

/**
 * The expo-router names this domain may still import, and why each one is not a router.
 *
 * `useFocusEffect` reads whether this screen is the focused one in the document's own stack and
 * `useLocalSearchParams` reads the params of the route already mounted. Neither takes a target, so
 * neither can put a screen in front of the page; both are the page's own router answering about the
 * page's own route, which is exactly what it is for.
 *
 * A closed list rather than a ban on `useRouter`: the hazard is anything that navigates, and
 * expo-router exports a module-singleton `router` that does it from a plain function. A rule written
 * against the one spelling would have read that as clean.
 */
const NON_NAVIGATING_ROUTER_NAMES = ['useFocusEffect', 'useLocalSearchParams']

describe('the session domain reaches the router through the handoff seam', () => {
  const files = productFiles(SESSION_ROOT)

  it('walks the modules it is written against', () => {
    expect(files).toEqual(expect.arrayContaining(ROUTER_HOLDERS))
    expect(files.length).toBeGreaterThan(200)
  })

  it('imports nothing from expo-router that can navigate', () => {
    const offenders = files
      .map((name) => ({
        name,
        imported: expoRouterValueImports(parse(SESSION_ROOT, name)).filter(
          (imported) => !NON_NAVIGATING_ROUTER_NAMES.includes(imported)
        )
      }))
      .filter((entry) => entry.imported.length > 0)
      .map((entry) => `${entry.name} (${entry.imported.join(', ')})`)
    expect(offenders).toEqual([])
  })

  it('takes the router from useRouteHandoff at every screen that holds one', () => {
    expect(files.filter((name) => callsRouteHandoff(parse(SESSION_ROOT, name))).sort()).toEqual(
      [...ROUTER_HOLDERS].sort()
    )
  })

  it('still reaches expo-router for the two names that answer about its own route', () => {
    // The completeness half: the rule above also passes over a domain that imports nothing at all,
    // which is what it would read as if someone moved these hooks and left the list behind.
    const imported = new Set(
      files.flatMap((name) => expoRouterValueImports(parse(SESSION_ROOT, name)))
    )
    expect([...imported].sort()).toEqual([...NON_NAVIGATING_ROUTER_NAMES].sort())
  })
})

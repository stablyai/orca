import { describe, expect, it } from 'vitest'
import {
  callsRouteHandoff,
  expoRouterValueImports,
  parse,
  productFiles
} from '../navigation/router-seam-census.test-support'

const SHELL_ROOT = import.meta.dirname

/**
 * The tree that is both halves of the handoff, which is why it needs its own census.
 *
 * Every other domain here is page code: a screen the shell may serve, where expo-router's own
 * router posts no `navigate` and a target outside the page paints Unmatched over it. This tree is
 * different — it holds the app end of the seam as well, so the rule cannot be "no router" and has
 * to name which modules are the app end.
 *
 * It is also the tree where the gap showed: `PageRouteUnavailableScreen` shipped with a bare
 * `useRouter` and nothing caught it, because the three landed censuses walk `src/session`,
 * `src/files` and `src/source-control` and this tree had none.
 */

/**
 * The two modules that ARE the app end of the handoff, and so hold expo-router's own router.
 *
 * `MobileWebShellScreen` is what hosts the page; its `router.push` is the `onNavigate` the page's
 * `navigate` notify arrives at, so routing it through the seam would hand the page's target back to
 * the page. `useShellStackPop` is the same for `onNavigateBack`: it pops the native stack the shell
 * was pushed onto. Neither has a `.web.*` sibling and neither can run inside the page — the page has
 * no shell within it — so neither is a screen the seam exists for.
 */
const SHELL_SIDE_ROUTER_HOLDERS = ['MobileWebShellScreen.tsx', 'use-shell-stack-pop.ts']

/**
 * The screens here that render on the page and therefore must reach the router through the seam.
 *
 * One today. `PageRouteUnavailableScreen` is rendered by the catch-all on the device and by its
 * `.web.tsx` sibling inside the page, so a bare replace there navigates within the WebView to a
 * route the page does not carry instead of leaving it.
 */
const ROUTER_HOLDERS = ['PageRouteUnavailableScreen.tsx']

/**
 * The expo-router names this tree may import outside those two, and why none is a router.
 *
 * `useLocalSearchParams` reads the params of the route already mounted and `usePathname` reads
 * which route that is. Neither takes a target, so neither can put a screen in front of the page.
 *
 * A closed list rather than a ban on `useRouter`, for the reason the session census gives:
 * expo-router also exports a module-singleton `router` that navigates from a plain function, and a
 * rule written against the one spelling would read that as clean.
 */
const NON_NAVIGATING_ROUTER_NAMES = ['useLocalSearchParams', 'usePathname']

describe('the mobile-web-shell tree reaches the router through the handoff seam', () => {
  const files = productFiles(SHELL_ROOT)

  it('walks the modules it is written against, so the empty list below means something', () => {
    expect(files).toEqual(expect.arrayContaining(SHELL_SIDE_ROUTER_HOLDERS))
    expect(files).toEqual(expect.arrayContaining(ROUTER_HOLDERS))
    // The whole tree, not the five files that touch a router: a walk that collapsed to those would
    // report an empty finding list for a domain it never read.
    expect(files.length).toBeGreaterThan(60)
  })

  it('imports nothing from expo-router that can navigate, outside the two that are the seam', () => {
    const offenders = files
      .filter((name) => !SHELL_SIDE_ROUTER_HOLDERS.includes(name))
      .map((name) => ({
        name,
        imported: expoRouterValueImports(parse(SHELL_ROOT, name)).filter(
          (imported) => !NON_NAVIGATING_ROUTER_NAMES.includes(imported)
        )
      }))
      .filter((entry) => entry.imported.length > 0)
      .map((entry) => `${entry.name} (${entry.imported.join(', ')})`)
    expect(offenders).toEqual([])
  })

  it('takes the router from useRouteHandoff at every screen the page renders', () => {
    expect(files.filter((name) => callsRouteHandoff(parse(SHELL_ROOT, name))).sort()).toEqual(
      [...ROUTER_HOLDERS].sort()
    )
  })

  it('still holds a real router at the app end, which is what the exemption is for', () => {
    // The completeness half: the rule above also passes over a tree whose two seam modules stopped
    // navigating at all, which is what it would read as if someone moved them and left this list.
    for (const name of SHELL_SIDE_ROUTER_HOLDERS) {
      expect(expoRouterValueImports(parse(SHELL_ROOT, name)), name).toContain('useRouter')
    }
  })
})

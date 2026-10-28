import { useMemo } from 'react'
import { usePathname, useRouter } from 'expo-router'
import {
  BRIDGE_MAX_ROUTE_HREF_CHARS,
  BRIDGE_ROUTE_HREF_PATTERN
} from '../mobile-web-shell/bridge/bridge-caps'
import { matchesRoutePattern } from '../mobile-web-shell/page-route-policy'
import { usePageBridgeClient } from '../transport/client-context.web'
import { stringifyRouteHref, type RouterHref } from './route-href'
import { useBackClaim } from './use-back-claim.web'
import type { RouteHandoff } from './route-handoff'

function pathnameOf(href: string): string {
  const cut = href.search(/[?#]/)
  return cut === -1 ? href : href.slice(0, cut)
}

type RouteHandoffOutcome = 'local' | 'handed-off' | 'refused'

// Inspect parameter tuples: assignability alone treats no-arg back/dismissAll/reload as href-taking functions.
type TakesHref<TMember> = TMember extends (...args: infer TArgs) => unknown
  ? TArgs extends [RouterHref, ...unknown[]]
    ? true
    : false
  : false

// Derive target-taking members from Expo so an upgrade adding one fails the pin until handoff policy covers it.
type HrefTakingRouterMember = {
  [K in keyof RouteHandoff]-?: TakesHref<RouteHandoff[K]> extends true ? K : never
}[keyof RouteHandoff]

export const WRAPPED_HREF_MEMBERS = [
  'push',
  'replace',
  'navigate',
  'dismissTo',
  'prefetch'
] as const

type WrappedHrefMember = (typeof WRAPPED_HREF_MEMBERS)[number]

// Pin both directions to catch unwrapped new members and obsolete wrapper names.
type AssertExtends<TNarrow extends TWide, TWide> = TNarrow
type PinnedMembersAreHrefTaking = AssertExtends<WrappedHrefMember, HrefTakingRouterMember>
type HrefTakingMembersArePinned = AssertExtends<HrefTakingRouterMember, WrappedHrefMember>
export type RouteHandoffMemberPin = [PinnedMembersAreHrefTaking, HrefTakingMembersArePinned]

type RouteHandoffRefusal = 'malformed-href' | 'shell-refused'

// Warn once per reason per memoized hook instance, not per document. A fault notify would trigger recovery for a navigation refusal, so keep it diagnostic.
function createRefusalReporter(): (reason: RouteHandoffRefusal, target: string) => void {
  const reported = new Set<RouteHandoffRefusal>()
  return (reason, target) => {
    if (reported.has(reason)) {
      return
    }
    reported.add(reason)
    console.warn('[page-bridge] route-handoff-refused', { reason, target })
  }
}

// Keep only served/authorized targets local; hand others to native and stay put on refusal so unsupported native screens cannot mount under RN Web.
// Local calls retain router options; handoff carries only href. Prefetch never opens native screens, while Back uses the stack that can actually pop.
export function useRouteHandoff(): RouteHandoff {
  const client = usePageBridgeClient()
  const router = useRouter()
  // Subscribe for rerenders when committed navigation changes; canGoBack otherwise has no reactive reader here.
  usePathname()
  // Recheck at the press because claim and Back cross separately; false returns a stale claim’s press to native.
  useBackClaim(
    router.canGoBack()
      ? () => {
          if (!router.canGoBack()) {
            return false
          }
          router.back()
          return true
        }
      : null
  )

  return useMemo<RouteHandoff>(() => {
    const report = createRefusalReporter()
    // Require listed patterns and grant coverage because local targets retain the opener’s authority. Missing pairs preserve older shells; a present list lacking this target cannot justify a local hop.
    const servedHere = (target: string): boolean => {
      const pathname = pathnameOf(target)
      const session = client.getShellSession()
      const pattern = (session?.pageRoutes ?? []).find((candidate) =>
        matchesRoutePattern(pathname, candidate)
      )
      if (pattern === undefined) {
        return false
      }
      const pairs = session?.pageRouteGrants ?? null
      if (pairs === null) {
        return true
      }
      const declared = pairs.find((entry) => entry.pathname === pattern)
      if (declared === undefined) {
        return false
      }
      const held = session?.grants.native ?? []
      return declared.grants.every((grant) => held.includes(grant))
    }
    const handOff = (href: RouterHref, replace = false): RouteHandoffOutcome => {
      // Resolve object hrefs; String would send [object Object], including for Connection-log links.
      const target = stringifyRouteHref(href)
      if (servedHere(target)) {
        return 'local'
      }
      // Validate the full href before posting: send success cannot prove shell acceptance, and pathname matching alone ignores refused fragments.
      if (target.length > BRIDGE_MAX_ROUTE_HREF_CHARS || !BRIDGE_ROUTE_HREF_PATTERN.test(target)) {
        report('malformed-href', target)
        return 'refused'
      }
      if (!client.notifyNavigate(target, replace)) {
        report('shell-refused', target)
        return 'refused'
      }
      return 'handed-off'
    }
    return {
      ...router,
      push: (href, options) => {
        if (handOff(href) === 'local') {
          router.push(href, options)
        }
      },
      // Native handoff uses push; Expo’s existing-screen collapse applies only within this document.
      navigate: (href, options) => {
        if (handOff(href) === 'local') {
          router.navigate(href, options)
        }
      },
      // Native replace would drop this whole document, so with in-page history the top entry is popped here and the target pushed over the rest.
      replace: (href, options) => {
        const inPageHistory = router.canGoBack()
        const outcome = handOff(href, !inPageHistory)
        if (outcome === 'local') {
          router.replace(href, options)
        } else if (outcome === 'handed-off' && inPageHistory) {
          router.back()
        }
      },
      // Pop in-page history when present; otherwise ask native, with local no-op fallback if posting is unavailable.
      back: () => {
        if (router.canGoBack() || !client.notifyNavigateBack()) {
          router.back()
        }
      },
      dismissTo: (href, options) => {
        if (handOff(href) === 'local') {
          router.dismissTo(href, options)
        }
      },
      // Prefetch only local targets: handing a background load to native navigate would open a screen nobody requested.
      prefetch: (href) => {
        if (servedHere(stringifyRouteHref(href))) {
          router.prefetch(href)
        }
      }
    }
  }, [client, router])
}

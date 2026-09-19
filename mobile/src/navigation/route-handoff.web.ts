import { useMemo } from 'react'
import { useRouter } from 'expo-router'
import {
  BRIDGE_MAX_ROUTE_HREF_CHARS,
  BRIDGE_ROUTE_HREF_PATTERN
} from '../mobile-web-shell/bridge/bridge-caps'
import { matchesRoutePattern } from '../mobile-web-shell/page-route-policy'
import { usePageBridgeClient } from '../transport/client-context.web'
import { stringifyRouteHref, type RouterHref } from './route-href'
import type { RouteHandoff } from './route-handoff'

/** The path half of a target, which is what the shell's route patterns are written against. */
function pathnameOf(href: string): string {
  const cut = href.search(/[?#]/)
  return cut === -1 ? href : href.slice(0, cut)
}

/**
 * Web sibling: a route the page renders it takes, and a route it does not it hands back.
 *
 * The page is one document standing in for one screen. Pushing a screen it does not carry would
 * paint expo-router's Unmatched, and re-entering the shell for it would re-execute a multi-megabyte
 * bundle on every tap, so the shell pushes the native screen over the still-mounted view instead
 * and Back reveals the page with nothing reloaded.
 *
 * The four members that can leave this document are wrapped and the rest are the router's own. The
 * three that carry a target are decided by one answer: the shell says which routes are the page's,
 * in `init`. `back` carries none and is decided by the document's own stack instead, because there
 * is no target to match — what it leaves for is whatever the shell pushed this page onto.
 *
 * A handoff the shell cannot honour — an older shell that granted no `navigate`, or a target the
 * protocol refuses — falls through to the local router: Unmatched is a worse screen than the one
 * the page is on, but a tap that does nothing at all is worse than both, and the route policy is
 * what keeps that case off a device.
 *
 * Whether the target names a screen that exists is nobody's business here; the shape is all this
 * can check, and C1.7 is where a real route-existence check belongs.
 */
export function useRouteHandoff(): RouteHandoff {
  const client = usePageBridgeClient()
  const router = useRouter()

  return useMemo<RouteHandoff>(() => {
    const handOff = (href: RouterHref): boolean => {
      // Resolved, not stringified: the object form is `[object Object]` under `String`, and the
      // Connection-log link on a reconnecting host builds one every time it renders.
      const target = stringifyRouteHref(href)
      const pathname = pathnameOf(target)
      const pageRoutes = client.getShellSession()?.pageRoutes ?? []
      if (pageRoutes.some((pattern) => matchesRoutePattern(pathname, pattern))) {
        return false
      }
      // Checked here, because `notifyNavigate` answers whether the frame left the page and not
      // whether the shell accepted it. The shell's reader drops a frame the pattern refuses, and a
      // handoff that reported success into a dropped frame is a tap that does nothing at all.
      // `pathnameOf` strips a fragment before matching, so without this an href carrying one is
      // posted whole and refused on the other side.
      if (target.length > BRIDGE_MAX_ROUTE_HREF_CHARS || !BRIDGE_ROUTE_HREF_PATTERN.test(target)) {
        return false
      }
      return client.notifyNavigate(target)
    }
    return {
      ...router,
      push: (href) => {
        if (!handOff(href)) {
          router.push(href)
        }
      },
      // The shell has one way to open a screen and it is a push, so a replace the page cannot keep
      // becomes one too. What it replaces is a history entry inside this document, which the native
      // stack never had; leaving it is what lets Back come back to the page.
      replace: (href) => {
        if (!handOff(href)) {
          router.replace(href)
        }
      },
      // The one member whose handoff needs no target: inside the page there is nothing behind this
      // document, because the entry wrote its single history entry with `replaceState`. A stack the
      // page did grow it pops itself; otherwise the stack that has somewhere to go is the native
      // one the shell pushed this page onto, and a shell that cannot pop it leaves Back exactly as
      // dead as it already was.
      back: () => {
        if (router.canGoBack() || !client.notifyNavigateBack()) {
          router.back()
        }
      },
      // The list's own way out of the host. Inside the page there is no stack to pop to: the phone's
      // home screen is a native route, so it is handed over like any other.
      dismissTo: (href) => {
        if (!handOff(href)) {
          router.dismissTo(href)
        }
      }
    }
  }, [client, router])
}

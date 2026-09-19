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

/** What became of a target, which is three answers and not two. */
type RouteHandoffOutcome = 'local' | 'handed-off' | 'refused'

/** Why a target went nowhere: a shape the protocol drops, or a shell that would not take it. */
type RouteHandoffRefusal = 'malformed-href' | 'shell-refused'

/** One line per reason for the life of one client, the bound every page-side reporter here takes. */
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

/**
 * Web sibling: a route the page renders it takes, a route it does not it hands back, and a target
 * it can do neither with it refuses.
 *
 * The page is one document standing in for one screen, so a route the shell says is the page's is
 * pushed here and every other one goes to the shell, which pushes the native screen over the
 * still-mounted view; Back reveals the page with nothing reloaded, and the multi-megabyte bundle is
 * never re-executed.
 *
 * The four members that can leave this document are wrapped and the rest are the router's own. The
 * three that carry a target are decided by one answer: the shell says which routes are the page's,
 * in `init`. `back` carries none and is decided by the document's own stack instead, because there
 * is no target to match — what it leaves for is whatever the shell pushed this page onto.
 *
 * The third answer is the one this file used not to have. `handOff` fails for two reasons that are
 * nothing like a page route — an href the protocol's own pattern drops, and a shell that answered
 * no — and falling through to the local router for either mounts a screen this page does not serve:
 * the bundle carries every route under `app/h`, so the fallback does not paint Unmatched, it runs
 * `session/[worktreeId]` on React Native Web inside the shell. Staying put and naming the reason is
 * the lesser failure, and the route policy is what keeps the case off a device in the first place:
 * a shell that grants no `navigate` renders no page route at all.
 *
 * `back` keeps a fallthrough the other three lost, and for the reason they lost theirs: it has no
 * target to mount, so `router.back()` on a document holding one history entry is the same nothing
 * a refusal would have been.
 *
 * Whether the target names a screen that exists is nobody's business here; the shape is all this
 * can check, and C1.7 is where a real route-existence check belongs.
 */
export function useRouteHandoff(): RouteHandoff {
  const client = usePageBridgeClient()
  const router = useRouter()

  return useMemo<RouteHandoff>(() => {
    const report = createRefusalReporter()
    const handOff = (href: RouterHref): RouteHandoffOutcome => {
      // Resolved, not stringified: the object form is `[object Object]` under `String`, and the
      // Connection-log link on a reconnecting host builds one every time it renders.
      const target = stringifyRouteHref(href)
      const pathname = pathnameOf(target)
      const pageRoutes = client.getShellSession()?.pageRoutes ?? []
      if (pageRoutes.some((pattern) => matchesRoutePattern(pathname, pattern))) {
        return 'local'
      }
      // Checked here, because `notifyNavigate` answers whether the frame left the page and not
      // whether the shell accepted it. The shell's reader drops a frame the pattern refuses, and a
      // handoff that reported success into a dropped frame is a tap that does nothing at all.
      // `pathnameOf` strips a fragment before matching, so without this an href carrying one is
      // posted whole and refused on the other side.
      if (target.length > BRIDGE_MAX_ROUTE_HREF_CHARS || !BRIDGE_ROUTE_HREF_PATTERN.test(target)) {
        report('malformed-href', target)
        return 'refused'
      }
      if (!client.notifyNavigate(target)) {
        report('shell-refused', target)
        return 'refused'
      }
      return 'handed-off'
    }
    return {
      ...router,
      push: (href) => {
        if (handOff(href) === 'local') {
          router.push(href)
        }
      },
      // The shell has one way to open a screen and it is a push, so a replace the page cannot keep
      // becomes one too. What it replaces is a history entry inside this document, which the native
      // stack never had; leaving it is what lets Back come back to the page.
      replace: (href) => {
        if (handOff(href) === 'local') {
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
        if (handOff(href) === 'local') {
          router.dismissTo(href)
        }
      }
    }
  }, [client, router])
}

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

/**
 * Whether a router member declares a target as its first argument.
 *
 * Declares, not accepts: `() => void` is assignable to `(href: RouterHref) => void`, so a test for
 * assignability calls `back`, `dismissAll` and `reload` target-takers and proves nothing. Reading
 * the parameter tuple is what tells a member that was given an href from one that merely tolerates
 * being handed one.
 */
type TakesHref<TMember> = TMember extends (...args: infer TArgs) => unknown
  ? TArgs extends [RouterHref, ...unknown[]]
    ? true
    : false
  : false

/**
 * Every member of the router that takes a target, derived from the router rather than listed.
 *
 * The spread below hands through everything this file does not name, so a member that takes an
 * href and is not wrapped is the hole the tri-state closes reopened under another name — which is
 * exactly how `navigate` and `prefetch` sat here unwrapped until round 2 found them. A new
 * href-taking member in a future expo-router changes this union, and the pin below stops compiling
 * until someone decides what the page does with it.
 */
type HrefTakingRouterMember = {
  [K in keyof RouteHandoff]-?: TakesHref<RouteHandoff[K]> extends true ? K : never
}[keyof RouteHandoff]

/** The members this file replaces, which must be that set exactly. */
export const WRAPPED_HREF_MEMBERS = [
  'push',
  'replace',
  'navigate',
  'dismissTo',
  'prefetch'
] as const

type WrappedHrefMember = (typeof WRAPPED_HREF_MEMBERS)[number]

// Both directions, so neither a member left unwrapped nor a name that is no longer the router's
// can pass. A failure here is a compile error in a product module, which is where a pin belongs.
type AssertExtends<TNarrow extends TWide, TWide> = TNarrow
type PinnedMembersAreHrefTaking = AssertExtends<WrappedHrefMember, HrefTakingRouterMember>
type HrefTakingMembersArePinned = AssertExtends<HrefTakingRouterMember, WrappedHrefMember>
export type RouteHandoffMemberPin = [PinnedMembersAreHrefTaking, HrefTakingMembersArePinned]

/** Why a target went nowhere: a shape the protocol drops, or a shell that would not take it. */
type RouteHandoffRefusal = 'malformed-href' | 'shell-refused'

/**
 * One line per reason per hook instance, which is the bound this can offer rather than the one
 * `createPageDiagnosticReporter` offers.
 *
 * The set lives in the `useMemo` below, keyed on `[client, router]`. `useRouter()` is expo-router's
 * module singleton and the page holds one client, so in practice the memo is not recomputed and a
 * reason is reported once — but every screen that calls this hook gets its own set, so a reason can
 * be reported once per screen rather than once per document. That is the honest bound: a per-module
 * set would outlive the page's client, which is the lifetime the rest of these reporters are scoped
 * to, and there is no document-wide reporter to join without reaching into a contract file.
 *
 * `console.warn` rather than the page's fault notify on purpose: this is the vocabulary
 * `createPageDiagnosticReporter` already writes in (`page-bootstrap.ts:35`), and a `fault` notify
 * would be wrong twice over — the shell drops the generation on a page fault, and a navigation the
 * page declined is not a page that failed.
 */
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
 * Six members are wrapped and the rest are the router's own. Five carry a target — `push`,
 * `replace`, `navigate`, `dismissTo` and `prefetch`, the set `WRAPPED_HREF_MEMBERS` pins — and four
 * of those are decided by one answer: the shell says which routes are the page's, in `init`.
 * `prefetch` is the fifth and is decided differently, below. `back` is the sixth and carries no
 * target at all, so it is decided by this document's own stack instead — what it leaves for is
 * whatever the shell pushed this page onto.
 *
 * The third answer is the one this file used not to have. `handOff` fails for two reasons that are
 * nothing like a page route — an href the protocol's own pattern drops, and a shell that answered
 * no — and falling through to the local router for either mounts a screen this page does not serve:
 * the bundle carries every route under `app/h`, so the fallback does not paint Unmatched, it runs
 * `session/[worktreeId]` on React Native Web inside the shell. Staying put and naming the reason is
 * the lesser failure, and the route policy is what keeps the case off a device in the first place:
 * a shell that grants no `navigate` renders no page route at all.
 *
 * `back` keeps a fallthrough the target-takers lost, and for the reason they lost theirs: it has no
 * target to mount, so `router.back()` on a document holding one history entry is the same nothing
 * a refusal would have been.
 *
 * Each target-taker is `(href, options?)` and forwards both on its local branch. Options do not
 * cross to the shell: the `navigate` notify carries an href and nothing else, so a target handed
 * over is opened by the native stack on that stack's own terms. Nothing in this tree passes one
 * today; the wrappers took the href alone until a review found it, which is exactly how a caller
 * that starts passing one would have had it dropped without a word.
 *
 * Whether the target names a screen that exists is nobody's business here; the shape is all this
 * can check, and C1.7 is where a real route-existence check belongs.
 */
export function useRouteHandoff(): RouteHandoff {
  const client = usePageBridgeClient()
  const router = useRouter()

  return useMemo<RouteHandoff>(() => {
    const report = createRefusalReporter()
    /**
     * Whether this document both renders the target and may: pattern listed, grants covered.
     *
     * Covered matters because grants are resolved once, from the route the shell opened, and a push
     * kept local runs the target under the opener's list. On a wide layout the sidebar reaches the
     * tasks page from every `/h` route, so keeping that hop local runs tasks without
     * `native.clipboard.write` and its copy actions refuse with nothing on screen to say why.
     * Handing it over instead opens it as its own session, with its own grants.
     *
     * A shell that sent no pairs gets the old answer: `null` is "nobody told me", which is not the
     * same as "this route needs nothing", and an older shell must keep working. A target the shell
     * lists but names no entry for is not covered — the page cannot justify the hop, so it hands it
     * over rather than guessing.
     */
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
    const handOff = (href: RouterHref): RouteHandoffOutcome => {
      // Resolved, not stringified: the object form is `[object Object]` under `String`, and the
      // Connection-log link on a reconnecting host builds one every time it renders.
      const target = stringifyRouteHref(href)
      if (servedHere(target)) {
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
      push: (href, options) => {
        if (handOff(href) === 'local') {
          router.push(href, options)
        }
      },
      // expo-router's own `navigate` is a push that may collapse onto an existing screen instead.
      // Which of the two it does is a decision about this document's stack, and a target outside
      // this document has no such stack, so it is handed over exactly as a push is.
      navigate: (href, options) => {
        if (handOff(href) === 'local') {
          router.navigate(href, options)
        }
      },
      // The shell has one way to open a screen and it is a push, so a replace the page cannot keep
      // becomes one too. What it replaces is a history entry inside this document, which the native
      // stack never had; leaving it is what lets Back come back to the page.
      replace: (href, options) => {
        if (handOff(href) === 'local') {
          router.replace(href, options)
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
      dismissTo: (href, options) => {
        if (handOff(href) === 'local') {
          router.dismissTo(href, options)
        }
      },
      // The one target-taker that must never reach the shell. A prefetch is a background load, not
      // an intent to open, and `navigate` is the only thing the shell can be told — so handing one
      // over would push a screen nobody asked for. A route this document serves is prefetched here,
      // which is the case the chunk split makes worth doing; every other one is dropped, without a
      // line, because a background optimisation that did not happen is not a failure to report.
      prefetch: (href) => {
        if (servedHere(stringifyRouteHref(href))) {
          router.prefetch(href)
        }
      }
    }
  }, [client, router])
}

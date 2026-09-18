# Plugin link routes (`contributes.linkRoutes`)

A plugin can declare that clicked links for certain hostnames should open in Orca's built-in browser
or in the system browser, overriding the user's `openLinksInApp` default for those hosts only.

A working example manifest lives at `examples/plugins/demo-link-routes/orca-plugin.json`.
The threat model is [`plugin-link-route-threat-model.md`](./plugin-link-route-threat-model.md).

## Manifest shape

```json
{
  "contributes": {
    "linkRoutes": [
      { "hostname": "docs.example.com", "destination": "orca-browser", "description": "…" },
      { "hostname": "*.example.com", "destination": "system-browser" },
      { "hostname": "*-devserver.test", "destination": "orca-browser" }
    ]
  }
}
```

`destination` is `orca-browser` or `system-browser`. `description` is optional, max 200 chars, and is
shown at consent time. At most `PLUGIN_LINK_ROUTE_LIMIT` (64) routes per plugin.

Matching is label comparison — no RegExp is ever built from manifest text
(`src/shared/plugins/plugin-link-route-matching.ts`). The hostname is canonicalized through the URL
parser (IDNA/UTS-46) before case folding, so the pattern and the clicked host are compared as the
same punycode string.

## The two wildcard forms

**`*.example.com` — single label.** Replaces exactly one label and never crosses a dot.
`app.example.com` matches; `a.b.example.com` does not.

Crossing a dot would defeat the public-suffix check that follows. `*.amazonaws.com` written as a
dot-crossing wildcard would reach `victim-bucket.s3.amazonaws.com` — across a tenant boundary — even
though `s3.amazonaws.com` is a private suffix. Single-label matching is what keeps the suffix check
meaningful.

The suffix check itself (`src/main/plugins/plugin-link-route-suffix-policy.ts`, main-only because it
needs `tldts`) rejects a wildcard whose tail is a public suffix: `*.com`, `*.co.uk`, `*.github.io`,
`*.s3.amazonaws.com`. `allowPrivateDomains: true` is what makes the last two suffixes rather than
ordinary domains.

**`*-devserver.test` — mid-label, reserved TLDs only.** The wildcard sits inside the registrable
label, so a whole-tail suffix test cannot protect it: against a real TLD, `*e.com` passes such a test
and captures google.com, apple.com and stripe.com. Mid-label wildcards are therefore restricted to
RFC 6761 / RFC 2606 names — `test`, `localhost`, `local`, `internal`, `example`, `invalid` — which
can never be publicly registered, and the literal prefix must be at least 6 characters so `*x.test`
cannot claim a whole dev namespace. This form exists for per-worktree dev servers.

A pattern that fails these rules is rejected at discovery (`plugin-discovery.ts`) and at install
staging, and the rejection drops the whole plugin — such a plugin never reaches the consent dialog.

## Precedence

`rankLinkRoutes` orders the approved table once, at reconcile time; click time is a plain `.find()`
over it. Exact hosts first, then longer literal tails, then plugin key, then declaration index. The
order is total and independent of install order. Do not re-sort in the renderer.

Two approved plugins claiming the same hostname: **neither** wins. The contested route is dropped
from the active table and annotated with a `conflict` string on each plugin's declared route, which
the consent dialog renders.

## Three views of the table

| Method                | Contents                                                                          | Read by                                                                    |
| --------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `list()`              | approved, conflict-filtered, ranked                                               | the `plugins:listLinkRoutes` IPC handler — the only set matching ever sees |
| `declared(pluginKey)` | everything the plugin asks for, approved or not, each annotated with its conflict | `plugin-list-projection.ts` → the consent dialog                           |

`listRegistrations()` and `conflicts()` were removed: both had zero callers, and the conflict a
caller would have wanted is now annotated onto each declared route.

## Consent

Link routes are instructional content: a route-only plugin must not be labelled "Declarative
content — no plugin code" while it is rerouting the user's clicks. The consent dialog reads
`declared()` off the plugin object pinned in its ref, with no independent `window.api` call.

Revocation works through the ordinary change path. Disable, uninstall, consent revoke, and kill-list
arrival all funnel into `performActivationStateReconciliation()` → `notifyChanged(true)`, which
makes the renderer refetch the table. A stale cached table here is a security bug, not UI lag.

## The gate order rule — the whole safety property

In `src/renderer/src/lib/http-link-destinations.ts`, `canSourceOwnerOpenInOrca` runs **before** route
matching, always. A route matched before that guard would let a plugin promote an SSH-owned or
runtime-owned link into an Orca browser tab the source host cannot reach. If you edit that function,
keep the guard first.

On a match, always emit the opposite destination as `alternate`. Both call sites take
`alternate ?? primary` on Shift; a routed `primary` with no `alternate` leaves the user no escape
hatch.

Route lookup is synchronous — it reads the already-fetched renderer store. Both click handlers call
`event.preventDefault()` synchronously, so an `await`ed IPC per click breaks that ordering. The first
frames after startup see an empty table and fall back to today's behavior; that cold-click window is
accepted, not a bug to "fix" with an await.

## Deliberate scope decisions

Each of these is a decision. None is an oversight.

- **Desktop IPC only.** `src/renderer/src/web/web-preload-api.ts` declares no `plugins` key. It is
  not literally undefined at runtime — `withFallback` hands back a proxy — but that proxy resolves
  `list*` calls to an empty result, so the route table on web/serve is always empty and routes never
  apply there. No RPC method was
  added; the host already publishes declared `linkRoutes` inside `plugins.list`, so there is no new
  wire surface to negotiate.
- **Mobile untouched.** Mobile has no link-destination logic and no plugin client.
- **No redirect following.** The route is matched against the URL as clicked. A host that redirects
  elsewhere is not re-evaluated.
- **No per-project scoping.** A route is global to the user's Orca once approved.
- **Other link surfaces are unrouted.** `openHttpLink` / `openRoutedHttpLink` have callers outside
  terminal and chat — editor markdown links, markdown preview, checks-panel review links — none of
  which compute `HttpLinkActionDestinations`. The same URL can open differently depending on where
  it was clicked.
- **A routed link is not attributed at click time.** Nothing in the popover, the hint or the opened
  tab says which plugin sent the link where it went. The only place a user sees a plugin's routes is
  the consent dialog, before approval. Attribution was considered and deliberately not built in this
  phase: the popover is only one of three activation gestures — modifier-click takes the direct
  branch and the popover can be disabled outright (`terminalLinkActionPopoverEnabled`) — so a badge
  there would have covered a third of the cases while reading as though it covered all of them.
- **The trust-tier warning copy is imprecise for a route-only plugin.** A plugin contributing only
  link routes is correctly classed as instructional, but the accompanying sentence reads "Review the
  instructions and commands below" — and it has neither. The declared hostnames are shown directly
  beneath it, so the disclosure itself is correct; only the lead-in is wrong. A fourth warning arm
  would fix it.
- **The hover hint lies.** `getUrlOpenLinkHint` takes no URL, so a routed link still hovers as
  "⌘+click to open, or ⇧⌘+click for system browser". Known; out of scope for this phase.
- **Nothing is logged.** The plugin subsystem has no audit log at all today — consent, kill and route
  activation are all unlogged. Do not invent one for link routes alone.

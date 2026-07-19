# Built-in Browser Local HTTPS and Certificate Trust

## Status

Implemented reference design for
[issue #8454](https://github.com/stablyai/orca/issues/8454).

The branch includes scheme-less local-dev URL classification, certificate-specific
failure copy, `Try HTTPS`, exact per-WebContents certificate grants,
`Proceed Anyway (Unsafe)`, local IPC, remote/headless runtime propagation, and
focused unit and real-Electron coverage. A session-level request gate contains
Chromium's cached certificate continuation so approval cannot leak to sibling
tabs, assets, fetches, iframes, or WebSockets. The release gates below remain
the acceptance contract for Electron upgrades and cross-platform validation.

## Summary

Orca's built-in browser cannot open a local HTTPS development server when the
server presents an untrusted certificate. A scheme-less local address also
defaults to HTTP, so entering `localhost:3000` does not discover an HTTPS-only
server.

This design keeps HTTP as the default for the scheme-less local forms that
already use it, adds a visible `Try HTTPS` recovery action after a failed local
HTTP navigation, and adds an explicit `Proceed Anyway (Unsafe)` path for an
untrusted local HTTPS certificate. Certificate approval is narrow and
temporary: it is bound to one browser WebContents, one secure endpoint, the
SHA-256 digest of the exact leaf certificate, and the specific certificate
error. A secure endpoint treats `https` and its companion `wss` scheme as one
TLS endpoint but still includes the canonical hostname and effective port. No
approval state is persisted.

The certificate decision runs in the process that owns the browser page. Local
desktop webviews use the desktop main process; SSH/headless pages use the remote
runtime process and expose the decision through runtime RPC.

## Problem

There are three independent behaviors behind the current failure.

1. `normalizeBrowserNavigationUrl` and the tab-create entry classifier prepend
   `http://` to scheme-less loopback input. Explicit `https://` input is already
   preserved.
2. Electron rejects an untrusted server certificate by default. Orca has no
   `certificate-error` decision flow, so a self-signed development certificate
   fails with a Chromium certificate error such as
   `ERR_CERT_AUTHORITY_INVALID (-202)`.
3. Browser load errors are presented as generic connectivity failures. For a
   loopback URL, Orca advises the user to check that the server is running even
   when the server responded and only certificate verification failed.

The same trust limitation exists in the offscreen browser backend used by
headless and SSH-owned browser pages. A desktop-only handler would fix the
visible local webview while leaving remote browser ownership inconsistent.

## Goals

- Show certificate-specific failure copy for main-frame certificate errors.
- Let a user explicitly approve an untrusted local development certificate.
- Bind approval to the exact browser surface, secure endpoint, leaf certificate
  digest, and certificate error.
- Keep approval in memory only and clear it with the owning browser surface.
- Support both desktop webviews and SSH/headless offscreen browser pages.
- Give scheme-less local input a discoverable path to HTTPS without silently
  changing the existing HTTP default.
- Preserve the current browser sandbox, navigation allowlist, session profiles,
  and mixed-content policy.
- Keep browser failure state accurate across event-order races, early webview
  attachment, reload, stale user actions, and remote latency.

## Non-goals

- Do not automatically trust a self-signed certificate.
- Do not disable `webSecurity`, enable insecure mixed content, or add
  `--ignore-certificate-errors`.
- Do not install a certificate into the operating-system trust store.
- Do not persist certificate exceptions across app restarts, browser surface
  recreation, or session-profile changes.
- Do not default every scheme-less localhost URL to HTTPS.
- Do not automatically probe HTTPS and then downgrade to HTTP.
- Do not add a general-purpose exception flow for public websites in v1.
- Do not make every Chromium certificate error overridable in v1.
- Do not extend localhost worktree-label proxying to HTTPS targets.

## Product Decisions

### Scheme-less local input continues to use HTTP

`localhost:3000` remains `http://localhost:3000/`. HTTP is still the common
development-server default, and changing the inference globally would turn
working HTTP servers into certificate or TLS failures.

When an HTTP navigation to a loopback URL fails, the browser failure overlay
offers `Try HTTPS`. The action replaces only the URL scheme and preserves the
host, explicit non-default port, path, query, and fragment. An absent port, or
an explicit `:80` normalized away by the URL parser, becomes HTTPS's default
port 443. Orca does not automatically retry because an invisible
cross-protocol retry would add latency, send an unexpected second request, and
make downgrade behavior opaque.

Explicit input remains authoritative:

- `http://localhost:3000` stays HTTP.
- `https://localhost:3000` stays HTTPS.
- URLs advertised by a workspace process keep their advertised scheme.

The shared browser URL domain becomes the source of truth for the existing
scheme-less local-dev classification. The tab-create entry classifier calls
that shared logic instead of keeping a second regular expression and scheme
rule. This consolidation must not reuse the stricter certificate-eligibility
predicate: doing so would change current behavior for inputs such as
`0.0.0.0`, bracketed non-loopback IPv6 addresses, and `.localhost` subdomains.

### V1 approval covers untrusted local authorities only

The first version offers `Proceed Anyway (Unsafe)` only when all of these are
true:

- the failure is for the main frame;
- the attempted URL is HTTPS;
- Electron reports `net::ERR_CERT_AUTHORITY_INVALID`, corresponding to
  Chromium load error `-202`;
- the host is an eligible loopback host;
- the WebContents is a browser surface managed by Orca; and
- Orca retained a live pending challenge for that browser surface.

Other certificate errors receive accurate copy but no bypass action. In
particular, v1 does not bypass revoked certificates, malformed certificates,
weak keys, date errors, or hostname/SAN mismatches. Expanding the allowlist
requires a separate security decision and dedicated tests.

### Eligible loopback hosts

The shared predicate accepts:

- `localhost`, case-insensitively, with an optional trailing dot;
- valid subdomains of `.localhost`, also with an optional trailing dot;
- valid IPv4 addresses in `127.0.0.0/8`; and
- IPv6 loopback `::1`.

The predicate does not treat `0.0.0.0`, `::`, arbitrary bracketed IPv6
addresses, private LAN addresses, or a DNS name that merely resolves to
loopback as certificate-bypass eligible. Wildcard bind addresses should already
be normalized to a connectable loopback address before navigation.

SSH local forwards are eligible when their browser-facing URL uses one of these
loopback hosts. Forwarding does not fix certificate names: a URL using
`127.0.0.1` still needs an IP SAN for `127.0.0.1`; a certificate containing only
`localhost` will fail with `ERR_CERT_COMMON_NAME_INVALID`, which v1 does not
bypass. Custom advertised DNS names remain subject to normal system trust in
v1, even if the name maps to loopback.

### Approval lifetime

An accepted grant is scoped to:

```text
browser WebContents ID + secure endpoint + leaf SHA-256 digest + error name
```

The secure endpoint canonicalizes `wss:` to its companion `https:` endpoint and
includes the normalized hostname and effective port. This lets an approved
local page load same-endpoint HTTPS assets and its WSS development socket. A
grant for `https://localhost:3000` does not apply to port 3001, to
`https://127.0.0.1:3000`, to another browser tab, or to a replacement
certificate.

Construct the secure endpoint from the parsed request URL: map `https:` and
`wss:` to `https:`, lowercase the hostname, remove one optional trailing dot,
use the URL parser's canonical IP representation, and use port 443 when the
parsed port is empty. Exclude credentials, path, query, and fragment. Reject
every other scheme.

Accepted grants survive reloads and same-surface navigation back to the exact
endpoint. They are cleared when the WebContents commits a main-frame navigation
whose canonical secure endpoint differs from the grant's endpoint (reusing the
per-WebContents navigation-sequence tracking), when the WebContents is destroyed
or replaced, the session profile changes, the browser-owning process exits, or
the app restarts. Binding grant lifetime to the granting main-frame document
prevents a later top-level document in the same tab — for example a navigation
to a public site — from silently reusing the loopback grant for a same-endpoint
iframe, fetch, or WSS subrequest.
Clearing a grant affects future requests; it cannot retroactively terminate a
document that already loaded. Grants are not written to settings, browser
history, workspace session state, or logs.

Chromium caches an accepted `certificate-error` continuation across the
Electron session partition. Orca therefore retains every endpoint/certificate
identity accepted in that partition until the browser-owning process exits and
gates all later HTTPS/WSS requests with `webRequest.onBeforeRequest`. Only the
WebContents holding the matching grant may reach a cached endpoint. A sibling
main-frame navigation receives a synthetic challenge for the known identity;
sibling subresources, fetches, iframes, workers, and WSS requests fail silently.

Because a preflight request gate cannot inspect the certificate that will be
presented after Chromium's cache is consulted, one endpoint is locked to the
first accepted untrusted leaf identity for that process lifetime. If that
endpoint later presents a different untrusted leaf, strict verification rejects
it and Orca does not offer another bypass until the browser-owning process
restarts. A replacement system-trusted certificate may load normally; the
conservative request gate still keeps sibling WebContents blocked until restart.

## User Experience

### Local HTTP failure

For a failed `http://` loopback navigation, keep the current connectivity
title and recovery hint. Add `Try HTTPS` when an HTTPS form can be constructed.

Example:

```text
Can't reach localhost:3000
We couldn't connect to your local server.

[Try HTTPS] [Retry] [Copy Address] [Open Externally]
```

`Try HTTPS` is the default button because it is the targeted recovery action
for a local HTTP failure. Keep the existing `Copy Address` recovery action;
`Retry` uses `outline`, while `Copy Address` and `Open Externally` stay quiet
secondary actions. `Try HTTPS` does not appear for an already-HTTPS URL or a
non-eligible host.

### Certificate failure

For `ERR_CERT_AUTHORITY_INVALID (-202)` on an eligible local endpoint, replace
the generic connectivity content with:

```text
Connection isn't secure
Orca doesn't trust the authority that issued the certificate for localhost:3000.

For local development, use a trusted local certificate when possible.

[Open Externally] [Retry] [Copy Address] [Proceed Anyway (Unsafe)]
```

- `Open Externally` is the default safe recovery action when the URL is
  reachable from the desktop.
- When `Open Externally` is unavailable, `Retry` becomes the default action.
- `Proceed Anyway (Unsafe)` uses `outline`; `Copy Address` stays quiet.
- `Proceed Anyway (Unsafe)` is always visibly labeled; it is not hidden behind
  a tooltip.
- The unsafe action does not use the destructive color. It does not delete or
  irreversibly mutate user data, and the explicit label carries the warning.
- Use a muted `ShieldAlert` icon from `lucide-react`; do not add a warning color
  or new token.

For a remote-owned page whose URL is remote localhost, `Open Externally` is
hidden because the desktop system browser cannot reach the remote loopback
address. It remains available for a desktop-owned page or a locally forwarded
URL.

For certificate errors that v1 does not permit bypassing, show the same
certificate-specific title with error-specific body text, `Retry`,
`Copy Address`, and an eligible `Open Externally` action. `Copy Address` remains
present as a quiet secondary action in every certificate-failure branch,
eligible or not, so only `Try HTTPS` and `Proceed Anyway (Unsafe)` toggle in and
out across cases. The same default-action rule applies as for `-202`:
`Open Externally` is the default when the URL is reachable from the desktop,
otherwise `Retry` becomes the default. Do not show the local-server-running
hint.

Use this presentation mapping, inserting the display host into the copy:

| Chromium code           | Body copy                                                                  | Proceed in v1                 |
| ----------------------- | -------------------------------------------------------------------------- | ----------------------------- |
| `-200`                  | `The certificate doesn't match {host}.`                                    | No                            |
| `-201`                  | `The certificate for {host} isn't valid at the current date and time.`     | No                            |
| `-202`                  | `Orca doesn't trust the authority that issued the certificate for {host}.` | Eligible local endpoints only |
| Other certificate error | `Orca couldn't verify the certificate for {host}.`                         | No                            |

Keep the raw error name/code available to diagnostics and optional details, but
do not make users interpret it to understand the primary failure.

### Interaction behavior

- The overlay is persistent inline UI because the user must read and act on the
  failure; do not use a toast.
- The overlay does not steal focus when it appears.
- Actions are reachable by Tab and have visible focus rings.
- Use `aria-live="polite"`; repeated background failures must not repeatedly
  announce the same message.
- Clicking `Proceed Anyway (Unsafe)` disables the action immediately, and also
  disables the other overlay actions (`Retry`, `Try HTTPS`, `Copy Address`,
  `Open Externally`) for the duration of the approval round-trip so a stale
  click cannot race the controller's own `loadURL`. Re-enable them once a
  success or typed-failure response returns.
- Map every `proceedCertificate` failure reason to an overlay outcome:
  `expired`, `changed`, `ineligible`, and `missing` keep the overlay open and
  show the inline recovery message below; `navigated` shows no message because
  the overlay for that navigation is already cleared. In every non-success case
  `Proceed Anyway (Unsafe)` stays disabled until a fresh pending challenge is
  announced rather than re-enabling on its own.
- Delay the spinner by 200 ms, matching the style guide's remote-latency rule.
  After that delay, show the canonical `Loader2` with `Connecting…` and use a
  fixed button width so the label swap cannot move adjacent actions.
- If approval expired or the certificate changed, keep the overlay open and
  show `The certificate changed or the approval expired. Retry the page.`
- A successful main-frame navigation clears the visible certificate failure.

The UI must use existing `background`, `foreground`, `muted-foreground`,
`border`, and `ring` tokens plus the existing shadcn `Button` primitive. No new
color, radius, or shadow tier is required. Do not apply a blanket opacity to
the overlay's interactive content; use semantic muted text classes so button
and focus-ring contrast remains intact. Put every new user-visible string
through the existing localization catalog.

## Architecture

### Ownership

The browser-owning main process is the only authority that can accept a
certificate challenge.

- Desktop-owned `<webview>` pages are controlled by the desktop main process.
- Headless/SSH-owned pages are controlled by the remote `orca serve` main
  process through `OffscreenBrowserBackend`.
- The renderer only presents a pending challenge and requests approval. It
  never decides whether a certificate is trusted.

### New main-process controller

Add `src/main/browser/browser-certificate-trust-controller.ts` to manage pending
certificate challenges, and
`src/main/browser/browser-certificate-request-guard.ts` to manage grants plus
the session-level cached-certificate request boundary.

The controller owns:

```ts
type BrowserCertificateFailure = {
  challengeId: string
  browserPageId: string
  errorCode: number | null
  error: string
  origin: string
  displayHost: string
  canProceed: boolean
  observedAt: number
}

type PendingBrowserCertificateChallenge = {
  challengeId: string
  guestWebContentsId: number
  browserPageId: string | null
  navigationSequence: number
  navigationUrl: string
  origin: string
  secureEndpoint: string
  leafCertificateSha256: string
  errorCode: number | null
  error: string
  expiresAt: number
}

type BrowserCertificateGrant = {
  guestWebContentsId: number
  secureEndpoint: string
  leafCertificateSha256: string
  error: string
}
```

Generate challenge IDs with `randomUUID()`. Compute the certificate identity in
the browser-owning main process as SHA-256 over the DER bytes of Electron's leaf
`certificate.data`; do not depend on the undocumented formatting or algorithm
of `certificate.fingerprint`. Renderer and runtime payloads expose no
certificate bytes or digest—only the challenge ID, display host, origin, error
code, error name, `canProceed`, and observation time.

Pending challenges expire after five minutes and are bounded to 32 entries.
Accepted grants are bounded to 32 entries per browser-owning process and are
also removed with their WebContents. Bounds evict the oldest entry and notify
the affected UI when a live challenge is evicted. Ordinary cleanup should keep
both collections much smaller. Accepted endpoint identities are not evicted:
Chromium's corresponding cache cannot be cleared narrowly, so forgetting one
would reopen cross-WebContents access until process exit.

### Certificate event handling

Register exactly one app-level `certificate-error` listener after Electron is
ready but before either a desktop window or the offscreen backend can create a
browser page. Every branch must call Electron's callback exactly once; an
unexpected exception fails closed with `callback(false)`.

Electron supplies the certificate error as a string on this event, while
`did-fail-load` supplies the Chromium number later. Normalize the string to one
canonical error name and map only known names to numbers for presentation. An
unknown name keeps `errorCode: null` and is never bypass-eligible.

For every event:

1. Resolve the WebContents through `BrowserManager` and reject unmanaged,
   retired, or popup WebContents.
2. Parse the request URL, normalize its secure endpoint, and compute the leaf
   certificate SHA-256 digest. Invalid data fails closed.
3. Compare the normalized error name, endpoint, and digest against an accepted
   grant for this exact WebContents. On an exact match, first retain the accepted
   identity in the owning Electron session, then call `event.preventDefault()`
   and `callback(true)`.
4. If no grant matches, reject non-main-frame failures without creating a
   challenge. Subresources and iframes can consume an existing grant but cannot
   mint one.
5. For a main-frame failure, record a pending challenge only when the URL and
   error are eligible. Notify the owning page when its page ID is known, then
   call `callback(false)`.

Track a monotonically increasing main-frame navigation sequence per
WebContents. A new main-frame navigation invalidates its pending challenge in
both main and renderer state before the next certificate decision. Repeated
identical events within one sequence reuse the challenge ID; a retry or a
different navigation gets a new ID. This prevents an old button or compromised
renderer from approving a page the user has already left.

The first failure is always rejected. User approval records a grant and reloads
the page; the next certificate event is the one that succeeds.

Do not leave Electron's callback pending while waiting for user input. Rejecting
first gives Orca a normal load-failure lifecycle, avoids an unbounded blocked
navigation, and makes stale approval cleanup deterministic.

Do not use `session.setCertificateVerifyProc`. It applies to an entire session
partition, cannot bind a decision to one browser page, and verification results
can be cached by Chromium's network service.

### Session request gate and Electron upgrade guard

The pinned Electron 43 binary caches `callback(true)` broadly enough that a
second WebContents in the same partition can load the endpoint without another
`certificate-error` event. The certificate callback alone is therefore not an
isolation boundary.

Install exactly one `webRequest.onBeforeRequest` listener on every Orca browser
session before its first page loads. Electron permits only one listener for this
event, so the browser session registry owns installation and removal. Once an
endpoint identity has been accepted, the listener blocks every HTTPS/WSS
request to that endpoint unless `details.webContentsId` has the matching grant.
Requests without a WebContents ID, including background/worker traffic, fail
closed. A blocked main-frame request recreates the challenge and certificate
load error; other resource types are canceled without replacing the current
page's overlay.

The real-Electron integration suite must prove same-tab reload, same-endpoint
HTTPS assets and WSS, different-tab documents and subresources, and
different-port isolation against the exact Electron version in
`pnpm-lock.yaml`. Any Electron upgrade that breaks those tests blocks release
until the design is revised; unit mocks are insufficient.

### BrowserManager integration

Add a narrow BrowserManager query API instead of exposing its internal maps:

```ts
getManagedBrowserGuestContext(webContentsId: number): {
  browserPageId: string | null
  worktreeId: string | null
  sessionProfileId: string | null
  owner: 'desktop-webview' | 'offscreen'
} | null
```

For guest lifecycle, follow the existing extracted-controller precedent
(`browser-grab-session-controller.ts`, `browser-guest-ui.ts`,
`browser-download-destination.ts`), all of which BrowserManager drives by
calling a plain method on the controller directly from `registerGuest` /
`unregisterGuest`. Have BrowserManager call
`certificateTrustController.onGuestRegistered({ browserPageId, webContentsId })`
and `.onGuestRetired(webContentsId)` from those same bodies, rather than adding a
new listener/emitter registration API to BrowserManager — there is no such
pub-sub surface in `src/main/browser` today and this single consumer does not
warrant introducing one.

`getManagedBrowserGuestContext` must recognize an attached primary desktop
guest before renderer registration, returning a null page ID, while rejecting
popup descendants that merely inherited browser policies. It must also
recognize offscreen pages after `registerOffscreenGuest` and stop recognizing a
guest immediately when BrowserManager retires or unregisters it. The controller
re-checks this ownership on every certificate event even if it still has an
in-memory grant.

An attached desktop webview can encounter a certificate error before its
document reaches `dom-ready`, which is when BrowserPane currently registers the
guest. Keep pending challenges keyed by WebContents ID until registration
supplies the page ID, then flush the failure to the renderer.

BrowserPane should also register idempotently on the webview's `did-attach`
event, with `dom-ready` retained as a fallback. `registerGuest` should report
whether the main process accepted the registration so a rare attach-policy race
can retry at `dom-ready`; the renderer must not cache the WebContents ID as
registered until it receives `true`.

Offscreen pages already register before `loadURL`, so their page ID is normally
available when the certificate event fires. Bring their main-frame navigation
and `did-fail-load` observation under the same BrowserManager lifecycle used by
desktop guests; the current offscreen loader only logs a rejected `loadURL`, so
it cannot by itself populate runtime failure snapshots.

### Renderer state

Certificate challenges are transient runtime state and must not be added to
the persisted `BrowserPage` schema.

Add a transient map to the browser store:

```ts
browserCertificateFailuresByPageId: Record<string, BrowserCertificateFailure>
```

The workspace session serializer must omit this map. Clear an entry when:

- the page completes a successful main-frame navigation;
- the user starts a different navigation;
- the page or workspace closes;
- the owning browser WebContents is replaced; or
- the main process reports that the challenge expired.

The existing `BrowserLoadError` remains the persisted diagnostic source. Add a
pure Chromium-error classifier for Electron 43's certificate range (`-200`
through `-219`, excluding the unused values) so certificate failures still
render accurate copy after restore even when no live challenge exists. A live
certificate failure's error code takes presentation precedence over a
synthesized `-1` Chromium-error-page fallback. Independently, only a live,
matching challenge controls whether `Proceed Anyway (Unsafe)` is enabled.

Use both the page ID and attempted origin when combining the live challenge
with `BrowserLoadError`. A stale challenge from a prior navigation must never
add a proceed action to a different failure. Main-process navigation-sequence
invalidation is the security boundary; renderer cleanup is defense in depth and
keeps the UI honest.

### Local IPC

Extend the browser preload API with:

```ts
onCertificateFailureChanged(
  callback: (event: {
    browserPageId: string
    failure: BrowserCertificateFailure | null
  }) => void
): () => void

proceedCertificate(args: {
  browserPageId: string
  challengeId: string
}): Promise<
  | { ok: true }
  | {
      ok: false
      reason: 'expired' | 'changed' | 'ineligible' | 'missing' | 'navigated'
    }
>
```

Register the handler with the existing browser IPC group and reuse
`isTrustedBrowserRenderer`. The main process resolves the page to its current
WebContents and then consumes the exact pending challenge. Renderer-provided
origin, error code, or certificate identity are never trusted.

On success, main consumes the challenge, records the grant, and calls
`loadURL` with the challenge's main-owned `navigationUrl`. It must not use
`webContents.getURL()`, which may be `chrome-error://chromewebdata/` or a
previously committed page. It also must not reload if the page's current
navigation sequence no longer matches the challenge. The renderer does not
assign `webview.src` as a second side effect.

### Remote runtime RPC

The remote browser owner exposes equivalent behavior through:

```text
browser.certificate.proceed
```

with the runtime worktree selector, remote browser page ID, and challenge ID.
Advertise support through a new `browser.certificate-trust.v1` capability only
when the runtime has both a browser backend and the certificate controller.
Keep the method out of the mobile-scope RPC allowlist; it is for an
authenticated runtime-scope Orca client presenting browser chrome, not a guest
page or unauthenticated caller.

Extend `RuntimeMobileSessionBrowserTab` compatibly with optional `loadError`
and `certificateFailure` fields. Both are emitted from live runtime state.
`loadError` keeps the existing `BrowserPage` last-known diagnostic semantics,
including workspace persistence; `certificateFailure` is transient and is
never written to workspace persistence. Controller changes, challenge expiry,
navigation, and offscreen `did-fail-load` must mark the runtime session snapshot
dirty so clients do not wait for unrelated state to change. Web clients and
desktop clients reconcile these fields through the existing remote page-handle
mapping. Each full snapshot replaces the prior transient certificate failure
for that page, including clearing it when the field is absent. An older runtime
without the capability always clears any previously mirrored proceed action.

When the active page has a remote owner, BrowserPane routes approval to that
environment. It must not call local desktop IPC. If the runtime lacks the new
capability, the UI still classifies the certificate failure accurately but does
not render `Proceed Anyway (Unsafe)`. `Try HTTPS`, retry, and other navigation
actions continue through the existing owner-aware navigation path rather than
touching a local webview for a remote-owned page.

### Scheme recovery

Add pure functions in the shared browser URL domain:

```ts
classifySchemeLessLocalDevAddress(rawInput: string): URL | null
isEligibleLocalCertificateHost(hostname: string): boolean
toHttpsRecoveryUrl(rawUrl: string): string | null
```

`classifySchemeLessLocalDevAddress` preserves the exact current HTTP-default
input set and is shared by address-bar normalization and tab-create entry. It
is deliberately broader than certificate eligibility.

`isEligibleLocalCertificateHost` accepts a parsed/canonical hostname; normalize
case and an optional trailing dot and handle the brackets returned by
`URL.hostname` for IPv6. Validate IPv4 octets and DNS label boundaries instead
of using a substring or loose suffix check.

`toHttpsRecoveryUrl` returns a value only for an HTTP URL with an eligible
loopback host. It changes `protocol` to `https:` on a parsed `URL` object and
preserves credentials, hostname, an explicit non-default port, path, query, and
fragment. When no port is present, including when the parsed HTTP URL normalized
`:80` away, the result uses HTTPS's default port 443. It never probes either
protocol.

Both address-bar submission and tab-create entry use the shared local-address
classifier. Existing advertised workspace-port URLs remain authoritative and
require no new probing.

## Security Model

### Invariants

- Default certificate verification remains strict.
- Only a trusted Orca renderer or authenticated runtime-scope Orca client can
  request approval.
- The renderer cannot choose the origin, certificate digest, error,
  WebContents, or eligibility result.
- A grant is exact-match only and never applies across tabs, ports,
  certificates, or browser-owning processes.
- Session-cached accepted endpoints remain request-gated until process exit,
  even after their original WebContents or bounded grant is removed.
- Certificate PEM/DER data and certificate digests do not enter workspace
  state, history, telemetry, or ordinary logs.
- Subresource and iframe certificate failures cannot mint an approval action;
  they can consume an already-approved exact-endpoint grant on the same
  WebContents.
- The proceed affordance exists only in Orca chrome; guest content has no
  direct approval channel. Main-process challenge validation remains the
  security boundary and does not assume proof of a physical click.
- A remote client cannot approve a certificate in a different runtime
  environment.
- Starting another main-frame navigation invalidates the pending approval in
  the browser-owning process, not only in renderer state.

### Threat cases

| Threat                                          | Required behavior                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Compromised web page sends forged IPC           | Guest WebContents has no preload API; trusted-renderer check rejects it.                                      |
| Compromised renderer invents a challenge        | Main consumes only a server-created pending challenge tied to the current page and WebContents.               |
| Certificate changes after approval              | Leaf-digest mismatch rejects; a second untrusted leaf for that endpoint cannot be bypassed until restart.      |
| Same host uses a different port                 | Secure-endpoint mismatch rejects.                                                                             |
| Another tab visits the approved endpoint        | WebContents mismatch rejects.                                                                                 |
| Approved tab later loads a foreign top document | Grant is invalidated when the main frame navigates to a different endpoint; the new document cannot reuse it. |
| Challenge is replayed                           | Challenge ID is single-use and expires.                                                                       |
| User leaves the failed page before clicking     | Navigation-sequence mismatch rejects without reloading the stale URL.                                         |
| Approved page opens same-endpoint WSS/HMR       | Existing endpoint grant permits it; WSS cannot create a grant by itself.                                      |
| Public site presents an untrusted certificate   | Host eligibility fails; no proceed action is available.                                                       |
| Remote page approval is sent locally            | Ownership routing and remote page handles select the browser-owning runtime.                                  |
| App restarts after approval                     | No persisted grant exists.                                                                                    |

## Failure Handling

- If a certificate event arrives before guest registration, retain it by
  WebContents ID and flush after registration.
- If guest registration never completes, expire the pending challenge without
  notifying unrelated pages.
- If `Proceed` arrives after expiry, navigation, or WebContents replacement,
  return a typed failure and leave strict verification in place.
- If reload fails for a different reason, clear the certificate challenge and
  present the new load error.
- If the same rejected challenge fires repeatedly in one navigation, coalesce
  it without rotating the challenge ID or stacking announcements.
- If the certificate-error listener cannot parse the URL or leaf certificate,
  reject normally and do not offer approval.
- If the remote connection drops during approval, keep the local UI stable and
  surface the runtime error inline after the latency threshold.
- If an unexpected controller error occurs, call Electron's callback once with
  `false`; never leave the request suspended.
- If an accepted main-frame page later opens a new same-endpoint TLS connection,
  apply the exact grant to that HTTPS/WSS subrequest. Reject unmatched
  subrequests silently without replacing the main-frame overlay.
- If an accepted endpoint presents a different untrusted leaf, reject it without
  replacing the process-lifetime accepted identity or offering a second bypass.

## Data and Privacy

No migration is required.

Add no new product analytics in v1. Do not record URLs, certificate digests,
challenge IDs, certificate subjects, or approval results. If product analytics
becomes a requirement later, define coarse actions in the existing typed
feature-interaction catalog as a separate reviewed change.

Existing diagnostics may retain the Chromium numerical error code, as they do
for other browser load failures. Debug logging must contain at most the error
name, page ID, owner kind, and normalized loopback host class; omit query
strings, full URLs, and certificate digests.

## Test Plan

### Shared URL tests

- Explicit HTTP and HTTPS local URLs remain unchanged.
- Scheme-less `localhost`, IPv4 loopback, and IPv6 loopback still normalize to
  HTTP.
- Tab-create and address-bar local-address classification stay in parity for
  the full legacy set, including wildcard and bracketed IPv6 inputs.
- The broader scheme-less classifier is not accidentally substituted for the
  stricter certificate-eligibility predicate.
- `toHttpsRecoveryUrl` preserves host, an explicit non-default port, path,
  query, and fragment; a URL with no parsed port changes from HTTP's default 80
  to HTTPS's default 443.
- `Try HTTPS` is unavailable for HTTPS, file URLs, public hosts, wildcard bind
  hosts, private LAN hosts, and invalid URLs.
- Loopback eligibility covers `localhost`, trailing-dot localhost,
  `.localhost` subdomains with and without a trailing dot, the full valid IPv4
  127/8 range, and bracketed or unbracketed `::1` after URL parsing.
- Reject malformed IPv4, arbitrary bracketed IPv6, `0.0.0.0`, `::`, and names
  that only contain the word `localhost`.

### Main-process trust-controller tests

- Unmanaged, retired, and popup WebContents are rejected without pending
  challenges.
- A managed `-202` loopback failure creates one pending challenge and calls
  `callback(false)`.
- Every event path calls its callback exactly once; only an accepted grant calls
  `preventDefault()` and `callback(true)`.
- The digest is SHA-256 over DER leaf bytes and is stable across PEM formatting.
- An exact accepted grant covers same-endpoint HTTPS assets, WSS, and iframes on
  the same WebContents without allowing those requests to mint a challenge.
- Wrong page, WebContents, origin, port, certificate digest, error type, and
  challenge ID fail closed.
- A token is single-use and expires after five minutes.
- Repeated identical failures in one navigation coalesce; a new navigation
  invalidates the token and rotates the challenge ID.
- Approving after navigation returns `navigated` and never reloads the old URL.
- Approval loads the main-owned challenged URL, not the current Chromium error
  URL or a renderer-supplied URL.
- Certificate rotation fails closed and cannot replace the process-lifetime
  accepted endpoint identity.
- WebContents destruction removes pending challenges and grants.
- Bounds evict the oldest pending challenge/grant.
- Registering a page after an early certificate event flushes the event to the
  correct renderer.
- Concurrent tabs and session profiles remain isolated.

### IPC and runtime tests

- Browser certificate IPC rejects untrusted senders and malformed arguments.
- Renderer-supplied origin or certificate-identity fields are neither accepted
  nor used.
- Local approval reloads only the currently mapped guest.
- Remote approval calls the owning environment's RPC with the remote page ID.
- Local IPC is not called for a remote-owned page.
- Mobile-scope runtime clients cannot call the approval method.
- Older runtimes without `browser.certificate-trust.v1` never show an enabled
  proceed action.
- Runtime snapshots carry live load errors and certificate failure state,
  publish immediately on changes, and do not add certificate challenges to
  persisted session schemas.
- A snapshot that omits or clears a challenge removes the mirrored proceed
  action rather than leaving a stale one behind.
- Two runtime environments with identical page IDs cannot approve each other's
  challenge.

### Renderer tests

- `-202` renders certificate-specific copy and no server-running hint.
- A live certificate challenge still wins when Chromium's error-page fallback
  produced diagnostic code `-1`.
- A live eligible challenge renders `Proceed Anyway (Unsafe)`.
- A restored `-202` load error without a live challenge remains accurate but
  cannot proceed.
- Other certificate errors render accurate copy without v1 bypass.
- Local HTTP failures render `Try HTTPS`; HTTPS and non-loopback failures do not.
- Starting a new navigation clears stale certificate state.
- Success clears the overlay.
- Proceed disables immediately, delays the spinner, and preserves its width.
- Expired/changed responses show the inline recovery message.
- Keyboard focus and `aria-live` behavior do not regress the address bar.
- `Copy Address` remains available, interactive content is not blanket-dimmed,
  and all new strings are present in the localization catalog.

### Electron integration

Run a local HTTPS server with a generated certificate whose SAN includes
`localhost` but whose authority is not trusted.

1. `https://localhost:<port>` fails with `-202` and shows certificate copy.
2. `Proceed Anyway (Unsafe)` reloads and renders the page.
3. HTTPS assets and a WSS echo/HMR endpoint on the same host and port load after
   approval; a different-port asset remains blocked.
4. Reload in the same tab remains allowed without broadening the grant.
5. A second tab using the same session profile, origin, and certificate remains
   blocked. This is a release-blocking assertion against the pinned Electron
   binary, not a mocked controller test.
6. Navigating away before clicking makes the old challenge unusable and does
   not pull the tab back to the failed URL.
7. Replacing the certificate keeps the original tab blocked and offers no
   second bypass until the browser-owning process restarts.
8. Closing and recreating the browser surface removes the grant.
9. Restarting Orca removes the grant.
10. A system-trusted local certificate loads without an interstitial.
11. A public/non-loopback untrusted origin has no proceed action.
12. A hostname/SAN mismatch shows certificate copy but no proceed action.
13. `localhost:<port>` first attempts HTTP and its failure offers `Try HTTPS`.

Repeat the ownership-sensitive cases for:

- a local desktop webview;
- an SSH local port forward opened in the desktop browser, using a certificate
  whose SAN matches the browser-facing forwarded hostname; and
- a headless/offscreen browser page owned by `orca serve` under Linux/Xvfb.

## Implementation Plan

1. Add the shared scheme-less local classifier, strict certificate-host
   predicate, secure-endpoint canonicalizer, and HTTPS-recovery function with
   focused tests.
2. Consolidate address-bar and tab-create local classification without changing
   current scheme defaults.
3. Add BrowserManager ownership/registration/retirement hooks, early
   `did-attach` registration with a `dom-ready` fallback, and offscreen load
   failure observation.
4. Add shared certificate failure/result types and the main-process trust
   controller, including navigation-sequence invalidation and the app-level
   listener. Its certificate-event handling resolves ownership through the
   BrowserManager hooks from step 3, so those must land first.
5. Add local IPC, preload APIs, and transient renderer state.
6. Add the certificate-specific classification and copy as new exported
   functions/branches in the existing `browser-notices.ts` (which already owns
   load-failure copy via `formatLoadFailureDescription` /
   `formatLoadFailureRecoveryHint`), and extract only the overlay JSX into a
   focused `browser-load-failure-overlay.tsx` module instead of growing the
   already grandfathered `BrowserPane.tsx`; do not add or extend a max-lines
   disable.
7. Add certificate-specific and `Try HTTPS` UI, preserve existing recovery
   actions, and update the localization catalog.
8. Add the offscreen/runtime capability, live snapshot fields and publication,
   and approval RPC.
9. Add unit, IPC, renderer, runtime, and real-Electron integration coverage.
10. Run formatting, typecheck, lint, localization verification, targeted tests,
    and cross-platform manual validation.

## Rollout

No feature flag is required for accurate error copy or `Try HTTPS` because both
paths preserve strict certificate verification.

The proceed path should ship only after desktop and offscreen ownership tests
pass. If remote runtime support cannot land in the same release, gate the
button on `browser.certificate-trust.v1`; local desktop support may ship while
older/remote owners retain accurate error copy and trusted-CA guidance.

Do not close issue #8454 until a packaged build has been validated against a
real self-signed local HTTPS server. Unit mocks alone do not establish Electron
certificate-event ordering.

## UI Quality Bar

- Follow `docs/STYLEGUIDE.md` and the adjacent browser failure overlay.
- Use only existing semantic tokens, shadcn buttons, and lucide icons.
- Keep the overlay quiet and monochrome; certificate failure must not introduce
  an amber warning treatment.
- Copy must distinguish connection, DNS, and certificate failures without
  claiming more than the Chromium error proves.
- Buttons must remain on one line at supported pane widths or wrap as one
  deliberate group without overlap.
- Validate light/dark mode, macOS/Windows/Linux font metrics, and 200 ms remote
  latency.
- Capture review evidence for local HTTP failure, eligible certificate failure,
  ineligible certificate failure, accepted certificate, and the same browser
  chrome after recovery.

## Release Gates and Open Risks

- The pinned Electron binary must prove that the session request gate blocks a
  second tab, sibling HTTPS subresources/WSS, and a second port even when
  Chromium does not re-emit `certificate-error`. If any isolation assertion
  fails, omit the proceed path or redesign it around a dedicated ephemeral
  partition; do not silently widen the grant.
- Same-endpoint WSS and fresh HTTPS subresource connections must work after
  approval. A main document that renders while HMR/API traffic remains blocked
  does not fix the local-development use case.
- A remote/headless certificate failure must reach the client as both accurate
  load-error copy and a live challenge. Logging a rejected offscreen `loadURL`
  is not sufficient.
- Stale approval must be rejected in the browser-owning process after any new
  main-frame navigation, including when renderer cleanup or a remote snapshot
  is delayed.
- SSH-forward validation must use a certificate whose SAN matches the
  browser-facing hostname. Authority bypass must not mask a hostname mismatch.
- The app-level listener and real-certificate tests must pass on macOS, Windows,
  and Linux/Xvfb. Platform trust-store differences do not justify enabling a
  broader error allowlist.

## Review Decisions and Follow-ups

### From 2026-07-12 review

- The integrated browser is part of the development workflow (including
  automation, annotations, and remote ownership), so `Open Externally` and trusted
  local-certificate guidance remain safer alternatives but do not replace an
  explicit in-browser decision.
- V1 intentionally limits approval to `ERR_CERT_AUTHORITY_INVALID (-202)`.
  Hostname/SAN, date, revoked, and malformed-certificate failures remain blocked;
  broadening that set requires a separate security review and real-certificate
  tests.
- Raw error details remain available to existing diagnostics rather than adding a
  new disclosure affordance to the quiet recovery overlay.

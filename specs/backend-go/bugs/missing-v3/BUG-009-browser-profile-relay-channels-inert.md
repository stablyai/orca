# BUG-009: `browser.*` — 7 of 19 called methods don't work end-to-end (3 profile-relay channels wired-but-inert; `tabShow`/`back`/`forward`/`reload` unregistered entirely)

**Service:** `api-gateway` (WS compat layer, wiring is real) / dev-server Agent (missing implementation)
**Files:**
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_browser_profiles.go:16-27`
- `agent/src/relay/agent-rpc-dispatch-browser.ts:1-209`
**Severity:** Medium — 7 of 19 `browser.*` operations frontend actually calls (via `callRuntimeRpc`) are unreachable end-to-end for a remote/backend-go-backed runtime target: 3 profile-relay ops are wired-in-`wscompat`-but-agent-inert (this report's original finding), plus 4 more (`browser.tabShow`, `browser.back`, `browser.forward`, `browser.reload`) discovered on 2026-09-07 re-verification to be unregistered in `wscompat` *and* unhandled by the agent — i.e. a strictly worse state than the profile-relay trio, which at least reaches the agent. The other 12 (nav/interaction ops) work end-to-end.
**Status:** Open (capability gap; corrects a stale over-count from pre-screening — see "Correction" below — and itself updated 2026-09-07 after discovering `tabShow`/`back`/`forward`/`reload` were missed by the original pass)

---

## Correction to pre-screening

The pre-screening candidates file (`missing-v3-candidates.md`) listed 12 `browser.*`
methods as "unregistered": `eval`, `keypress`, `mouseDown`, `mouseMove`, `mouseUp`,
`mouseWheel`, `profileClearDefaultCookies`, `profileDetectBrowsers`,
`profileImportFromBrowser`, `tabClose`, `tabCreate`, `viewport`. That was produced by
grepping for literal `r.Register("...")` string calls, which misses backend-go's two
loop-driven registration sites:

- `channels_browser.go:16-32` (`registerBrowserChannels`) loops over
  `["goto", "snapshot", "click", "eval", "keypress", "mouseDown", "mouseMove",
  "mouseUp", "mouseWheel", "viewport", "tabCreate", "tabClose"]` and calls
  `r.Register("browser."+op, ...)` for each — a dynamic channel name the literal-string
  grep can't see.
- `channels_browser_profiles.go:24-26` loops over `["profileClearDefaultCookies",
  "profileDetectBrowsers", "profileImportFromBrowser"]` the same way.

So **all 15 of these channels are in fact registered** in `wscompat`. Verified directly:

```
grep -n "case 'browser\." agent/src/relay/agent-rpc-dispatch-browser.ts
```

`goto`, `snapshot`, `click`, `eval`, `keypress`, `mouseMove`, `mouseDown`, `mouseUp`,
`mouseWheel`, `viewport`, `tabCreate`, `tabClose` (plus `screencastStart`/`screencastStop`)
all have real cases in the agent's dispatch switch, each delegating to a real handler in
`agent/src/relay/browser-handler.ts` that drives an actual headless-Chromium process via
the vendored `agent-browser` CLI (`agent-rpc-dispatch-browser.ts:1-10`'s header comment).
**These 9+3 methods are a fully working end-to-end path today — not a gap.** No report
needed for them.

## What's actually missing

The 3 `browser.profile*` relay channels are registered
(`channels_browser_profiles.go:16-27`, `registerBrowserProfileRelay`, same
resolve-`devServerId`-then-`Relay` skeleton as the interaction ops) but that file's own
comment says it plainly:

> `channels_browser_profiles.go:21-23`: "Relayed to the agent, keyed by dev_server_id
> directly (no worktree involved — a profile is dev-server-scoped). **INERT until the
> agent implements these 3 methods** — see TASK-036."

Confirmed still true: `agent/src/relay/agent-rpc-dispatch-browser.ts`'s `switch (rpc.method)`
has no `case 'browser.profileClearDefaultCookies'`, `case 'browser.profileDetectBrowsers'`,
or `case 'browser.profileImportFromBrowser'` — only the interaction/nav ops and the two
screencast ops are handled. The `default:` case (`agent-rpc-dispatch-browser.ts:206-207`)
returns `null`, which the caller turns into a generic "method not handled" JSON-RPC error.

So today, calling any of these 3 methods against a remote/backend-go-backed environment:
1. Reaches `wscompat`'s registered channel — no `notImplementedHandler` error.
2. Resolves the dev server's connection successfully (if one exists).
3. Relays a `browser.profile*` JSON-RPC call to the agent.
4. **Fails** — the agent has no handler for that method name and returns an error.

Frontend call sites that will observe this failure when a remote target is active:
`frontend/src/renderer/src/runtime/runtime-browser-client.ts:80-126`
(`browserProfileDetectBrowsers`, `browserProfileImportFromBrowser`,
`browserProfileClearDefaultCookies`) and their mirrors in
`frontend/src/renderer/src/store/slices/browser.ts:1919,1959,2056`.

## Additional gap found on 2026-09-07 re-verification: `browser.tabShow`/`back`/`forward`/`reload`

The original version of this report (and the pre-screening candidates file it corrected)
only cross-checked the 15 methods `frontend/src/renderer/src/runtime/runtime-browser-client.ts`
and the pre-screening scan's 12-item "unregistered" list named. A fuller sweep of every
`callRuntimeRpc('browser....')` call site in
`frontend/src/renderer/src/components/browser-pane/browser-pane-remote.tsx` turns up 4 more
real, dynamic-target call sites this report had not covered:

| Method | Frontend call site |
|---|---|
| `browser.tabShow` | `browser-pane-remote.tsx:762-767` (`fetchRemoteTabInfo`) |
| `browser.back` | `browser-pane-remote.tsx:1189-1220` (`runRemoteNavigation`'s `method` union, `browser-pane-remote.tsx:1191`), invoked at `:1731`, `:1800` |
| `browser.forward` | same `runRemoteNavigation`, invoked at `:1741`, `:1808` |
| `browser.reload` | same `runRemoteNavigation`, invoked at `:1751`, `:1816` |

None of these 4 are registered in `wscompat`:

```
grep -rn '"browser\.tabShow"\|"browser\.back"\|"browser\.forward"\|"browser\.reload"' backend-go/services/api-gateway/internal/adapter/wscompat/*.go
(no matches)
```

And unlike the 12 working interaction ops, they are **also absent from the agent's own
dispatch switch** — `agent/src/relay/agent-rpc-dispatch-browser.ts`'s `case` list covers
exactly `goto`, `snapshot`, `click`, `eval`, `keypress`, `mouseMove`, `mouseDown`, `mouseUp`,
`mouseWheel`, `viewport`, `tabCreate`, `tabClose`, `screencastStart`, `screencastStop` — no
`tabShow`, `back`, `forward`, or `reload` case anywhere in that file. So these 4 fail one
step earlier than the profile-relay trio above: they never even reach
`registerBrowserRelay`'s loop (`channels_browser.go:25-31` only iterates the 12-op list),
meaning they hit `wscompat`'s `notImplementedHandler` directly rather than reaching the agent
and failing there.

Practical impact: the browser pane's back/forward/reload toolbar buttons
(`browser-pane-remote.tsx:1800,1808,1816`) and keyboard shortcuts (`:1731,1741,1751`) are
non-functional against a remote/backend-go-backed runtime target, as is whatever
`fetchRemoteTabInfo`/`tabShow` backs (re-reading a remote tab's current title/URL after an
operation — used by `ensureRemotePage`'s cached-handle path, `browser-pane-remote.tsx:730-742`).

This does not change this report's "Owning service verdict" below — same owner
(`infra-fleet-service` + dev-server Agent), same shape of fix (add `wscompat` relay
registrations mirroring `registerBrowserRelay`'s existing 12-op loop, plus 4 new agent-side
`case` handlers in `agent-rpc-dispatch-browser.ts` backed by the same headless-Chromium
process the 12 working ops already drive) — it just means the true remaining surface is
larger than the original version of this report stated.

## Owning service verdict

Correctly identified already (`channels_browser_profiles.go`'s header comment references
`SOL-006-browser-channels.md`) — `infra-fleet-service` + the dev-server Agent is the right
owner; backend-go's own wiring is done and correct. This is purely an **agent-side capability
gap**: `agent/src/relay/browser-handler.ts` needs real
`handleBrowserProfileClearDefaultCookies` / `handleBrowserProfileDetectBrowsers` /
`handleBrowserProfileImportFromBrowser` implementations (reading/writing the headless
browser's cookie jar and enumerating/importing from locally-installed browser profiles on
the dev-server host), each wired into `agent-rpc-dispatch-browser.ts`'s switch the same way
the 12 already-working ops are. No new backend-go proto/usecase work is needed — the
gateway-to-agent transport and dispatch skeleton already exist and are proven correct by
the 12 working sibling methods.

---

## References

- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_browser.go:16-32` — interaction-ops loop registration (working)
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_browser_profiles.go:16-27` — profile-ops loop registration (inert, by its own comment)
- `agent/src/relay/agent-rpc-dispatch-browser.ts:26-207` — agent dispatch switch, no profile-op cases
- `agent/src/relay/browser-handler.ts` — where real profile-op handlers would need to be added
- `frontend/src/renderer/src/runtime/runtime-browser-client.ts:80-126` — frontend call sites affected
- `specs/backend-go/bugs/missing-v1/BUG-006-browser-channels-not-implemented.md` — predecessor report (marked partial/resolved for the interaction ops)
- `specs/backend-go/bugs/missing-v1/solutions/SOL-006-browser-channels.md` — original design doc (TASK-036)
- `frontend/src/renderer/src/components/browser-pane/browser-pane-remote.tsx:762-767,1189-1220,1731,1741,1751,1800,1808,1816` — `tabShow`/`back`/`forward`/`reload` call sites (2026-09-07 addition)
- `agent/src/relay/agent-rpc-dispatch-browser.ts:26-207` — confirmed no case for `tabShow`/`back`/`forward`/`reload` either (2026-09-07 re-check)

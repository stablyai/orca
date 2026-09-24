# Cursor usage credentials

Orca reads Cursor plan usage from the sign-in that already exists on the machine
running Orca. It never writes, refreshes, or rotates a Cursor credential, and it
never runs `cursor-agent login` on the user's behalf.

## Where the session lives

`readCursorAuthSession()` (`src/main/rate-limits/cursor-auth.ts`) tries three
stores in order and takes the first that yields a token with a WorkOS subject:

| Order | Source | Location | Who writes it |
| --- | --- | --- | --- |
| 1 | `keychain` | macOS login keychain, service `cursor-access-token`, account `cursor-user` | `cursor-agent` 2026.06+ |
| 2 | `cli` | `~/.cursor/auth.json` (`%APPDATA%\Cursor\auth.json`, `$XDG_CONFIG_HOME/cursor/auth.json`) | older `cursor-agent` builds, and non-macOS hosts |
| 3 | `desktop` | Cursor IDE `state.vscdb`, key `cursorAuth/accessToken` | the Cursor IDE |

**The keychain entry is the one current CLIs use.** Reading only `auth.json`
finds nothing on an up-to-date macOS install, which is why the fallback order
matters: a keychain read failure (locked keychain, denied access) must not hide
a readable `auth.json`, and a locked `state.vscdb` must not hide either.

`~/.cursor/cli-config.json` holds the signed-in identity under `authInfo`
(`email`, `displayName`) but **never a token**; it is read only to label the
account in Settings → Accounts.

## Token expiry

The stored access token is a JWT. `cursor-agent` refreshes it when the user runs
Cursor; Orca does not, because a refresh would rotate the credential the CLI
owns. When `exp` has passed, the fetcher short-circuits with `stale-token` and
tells the user to run `cursor-agent login` rather than spending a request that
can only 401.

A lapsed token is not a rare edge case: `cursor-agent status --format json` still
reports `isAuthenticated: true` with an access token that expired months ago.

## The usage endpoint

There is **no documented individual-user usage API** — [Cursor's documented
APIs](https://cursor.com/docs/api) are all team- or organization-scoped and need
an Enterprise `crsr_` key. Orca reads the same dashboard route the Cursor web
dashboard reads:

- `GET https://cursor.com/api/usage-summary` with
  `Cookie: WorkosCursorSessionToken=<subject>::<jwt>`.
- Dashboard routes check the request origin as CSRF defence, so `Origin` and
  `Referer` must be sent; a bare cookie gets a 403 on a perfectly valid session.
- `GET https://cursor.com/api/usage?user=<subject>` is a fallback for accounts
  still on request-quota billing, which report nothing under `individualUsage`.

Because the route is undocumented, the mapping is defensive: every field is
optional, and an unrecognised payload resolves to `unavailable` (bar hidden)
rather than to a zero that reads as "no usage".

## What the pools mean

[Cursor's pricing docs](https://cursor.com/docs/account/pricing) describe two
pools for individual plans, both resetting with the monthly billing cycle, plus
optional on-demand spend once they run out:

- **Cursor Models** — first-party models (`plan.autoPercentUsed`).
- **Other Models** — third-party models at API price (`plan.apiPercentUsed`).
- **On-demand** — only when the user has enabled it (`onDemand.enabled`).

The headline monthly figure prefers `plan.used / plan.limit` over the sibling
percentage fields: the raw pair is internally consistent, while the percentages
are pre-rounded for the dashboard's own copy and disagree with it on real
accounts. `isUnlimited` plans publish the plan tier with no bar, because there is
no ceiling to divide by.

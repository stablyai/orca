# Cursor usage tracking

Orca surfaces Cursor plan usage in the status bar, usage roster, Stats pane, and Accounts settings. Auth and parsing follow the same approach as [CodexBar's Cursor provider](https://github.com/steipete/CodexBar/blob/main/docs/cursor.md).

## Data source

Cursor has no public usage API. Orca reads the signed-in session from Cursor IDE:

1. **Primary:** `cursorAuth/accessToken` in Cursor's VS Code global state DB (`state.vscdb`)
2. Optional email from `cursorAuth/cachedEmail`
3. Derives `WorkosCursorSessionToken={userId}%3A%3A{accessToken}` (JWT `sub` → user id)
4. Fetches `GET https://cursor.com/api/usage-summary` and `GET https://cursor.com/api/auth/me`

Platform paths:

| OS | `state.vscdb` |
|----|----------------|
| macOS | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| Linux | `$XDG_CONFIG_HOME/Cursor/User/globalStorage/state.vscdb` |
| Windows | `%APPDATA%/Cursor/User/globalStorage/state.vscdb` |

## UI mapping

Plan total lives in `monthly`. Auto and API are named `buckets` (not Session/Weekly labels).

| Orca field | Cursor source |
|------------|----------------|
| `monthly` | `individualUsage.plan.totalPercentUsed` (fallback: auto/api average, cents ratio) |
| `buckets` | `Auto` ← `autoPercentUsed`, `API` ← `apiPercentUsed` |
| `session` / `weekly` | always `null` |
| Reset | `billingCycleEnd` |
| Auth label | cached email, `/api/auth/me`, or membership type |

## Files

| Area | Path |
|------|------|
| Auth | `src/main/rate-limits/cursor-auth.ts` |
| Fetch | `src/main/rate-limits/cursor-fetcher.ts` |
| Polling | `src/main/rate-limits/service.ts` (`fetchCursorOnly`, `refreshCursor`) |
| Account status | `src/main/cursor-accounts/status.ts` |
| Stats pane | `src/renderer/src/components/stats/CursorUsagePane.tsx` |
| Settings | `src/renderer/src/components/settings/CursorAccountsSection.tsx` |

## Out of scope (v1)

- Browser cookie import (CodexBar macOS feature)
- Manual cookie header in settings
- Multi-account switching
- On-demand spend as the primary meter
- Historical token/cost charts from `POST /api/dashboard/get-filtered-usage-events`
- Automation run usage attribution for Cursor agent sessions

## Testing

```bash
pnpm test \
  src/main/rate-limits/cursor-auth.test.ts \
  src/main/rate-limits/cursor-fetcher.test.ts \
  src/main/cursor-accounts/status.test.ts \
  src/main/rate-limits/service.test.ts \
  src/shared/cursor-session-paths.test.ts \
  src/renderer/src/components/stats/CursorUsagePane.test.tsx \
  src/renderer/src/components/settings/CursorAccountsSection.test.tsx \
  src/renderer/src/components/status-bar/tooltip.test.ts \
  src/renderer/src/components/status-bar/provider-segment-monthly-window.test.tsx
```

Requires Node 24 (`engines` in `package.json`).

# On-Demand Update Notification Nudge

## Context

Users on older versions may have dismissed the update card or missed the auto-update check window (24-hour interval). We need a way to re-surface the update notification on demand for users on specific versions — e.g., after a critical fix or when adoption of a new release is slow. The existing `UpdateCard` UI and updater state machine are fully reused; no new UI states or components.

## Design

### Remote Nudge Endpoint

New JSON endpoint at `https://onorca.dev/whats-new/nudge.json`:

```json
{
  "id": "2026-04-12-critical-fix",
  "versions": "<1.1.20"
}
```

- **`id`** — unique identifier per nudge campaign. Tracked on-device to prevent re-nudging after user dismisses.
- **`versions`** — version constraint. Supports `<X.Y.Z` and `<=X.Y.Z` (covers 100% of the use case: "everyone below version X should update").

When no nudge is active, endpoint returns `{}` or `null`.

### When It Runs

Piggybacked on the existing update check cycle. Fetched **in parallel with the changelog** inside the `update-available` handler's async block — adds zero extra latency. Fires only when electron-updater confirms a newer version exists (the `update-available` event). **Not** checked on `update-not-available` (user is already on latest — nothing to nudge).

### What It Does (when matched)

1. **Persist nudge ID** — `store.updateUI({ lastSeenNudgeId: nudge.id })`. On subsequent checks, same ID → skip.
2. **Clear dismissal in persistence** — `store.updateUI({ dismissedUpdateVersion: null })` so a restart also shows the card.
3. **Clear dismissal in renderer** — send `updater:clearDismissal` IPC → renderer sets `dismissedUpdateVersion = null` in Zustand.
4. **Send status normally** — `sendStatus({ state: 'available', ... })` proceeds as usual. Because dismissal was cleared *before* the status arrives, the UpdateCard renders immediately with no flash.

### What It Does NOT Do

- Does not trigger a new `checkForUpdates()` — it's already inside a check cycle.
- Does not add a new UI state or UpdateCard variant — the existing card handles everything.
- Does not involve the renderer in nudge ID tracking — that's a main-process-only concern.

---

## Implementation

### 1. New: `src/main/updater-nudge.ts`

```typescript
// Pattern follows updater-changelog.ts (net.fetch, 5s timeout, shape validation)

export type NudgeConfig = { id: string; versions: string }

export async function fetchNudge(): Promise<NudgeConfig | null>
// Fetches nudge.json, validates shape, returns null on error/empty.

export function satisfiesVersionConstraint(appVersion: string, constraint: string): boolean
// Parses "<X.Y.Z" / "<=X.Y.Z", evaluates using compareVersions() from updater-fallback.ts.

export function shouldNudge(
  nudge: NudgeConfig,
  appVersion: string,
  lastSeenNudgeId: string | null
): boolean
// Returns true if: nudge.id !== lastSeenNudgeId AND satisfiesVersionConstraint(appVersion, nudge.versions)
```

### 2. Modify: `src/main/updater-events.ts`

In the `update-available` handler, fetch nudge in parallel with changelog:

```typescript
// Inside the existing async IIFE:
const [changelog, nudge] = await Promise.all([
  fetchChangelog(info.version, app.getVersion()).catch(() => null),
  fetchNudge().catch(() => null)
])

// ... existing guard check ...

// Apply nudge before sendStatus so dismissal is cleared before the card renders
if (nudge && shouldNudge(nudge, app.getVersion(), getLastSeenNudgeId())) {
  applyNudge(nudge.id)  // persists nudge ID + clears dismissal in persistence + sends IPC
}

sendStatus({ state: 'available', version: info.version, changelog })
```

Add new callbacks to `UpdaterHandlerContext`:
- `getLastSeenNudgeId: () => string | null`
- `applyNudge: (nudgeId: string) => void`

### 3. Modify: `src/main/updater.ts`

In `setupAutoUpdater`, provide the new context callbacks:

```typescript
getLastSeenNudgeId: () => store.getUI().lastSeenNudgeId ?? null,
applyNudge: (nudgeId: string) => {
  store.updateUI({ lastSeenNudgeId: nudgeId, dismissedUpdateVersion: null })
  mainWindowRef?.webContents.send('updater:clearDismissal')
}
```

Thread `store` into `setupAutoUpdater` (currently it only receives callbacks — we need to either pass the store or add persistence callbacks to opts).

### 4. Modify: `src/shared/types.ts`

Add to `PersistedUIState`:
```typescript
lastSeenNudgeId?: string | null
```

### 5. Modify: `src/preload/index.ts`

Add to `updater` section:
```typescript
onClearDismissal: (callback: () => void): (() => void) => {
  const listener = () => callback()
  ipcRenderer.on('updater:clearDismissal', listener)
  return () => ipcRenderer.removeListener('updater:clearDismissal', listener)
}
```

### 6. Modify: `src/renderer/src/hooks/useIpcEvents.ts`

Subscribe to the new event:
```typescript
unsubs.push(
  window.api.updater.onClearDismissal(() => {
    useAppStore.getState().clearDismissal()
  })
)
```

### 7. Modify: `src/renderer/src/store/slices/ui.ts`

Add `clearDismissal` action:
```typescript
clearDismissal: () => set({ dismissedUpdateVersion: null })
// No persistence call needed — main process already cleared it.
```

### 8. `src/main/persistence.ts`

No changes needed — `lastSeenNudgeId` is in `PersistedUIState` and `Store.getUI()` / `Store.updateUI()` already handle arbitrary UI fields via spread.

---

## Key Files

| File | Change |
|------|--------|
| `src/main/updater-nudge.ts` | **New** — fetch + version matching logic |
| `src/main/updater-events.ts` | Parallel nudge fetch in `update-available` handler, expanded context type |
| `src/main/updater.ts` | New context callbacks (`getLastSeenNudgeId`, `applyNudge`) |
| `src/shared/types.ts` | `lastSeenNudgeId` on `PersistedUIState` |
| `src/preload/index.ts` | `onClearDismissal` listener |
| `src/renderer/src/hooks/useIpcEvents.ts` | Subscribe to `updater:clearDismissal` |
| `src/renderer/src/store/slices/ui.ts` | `clearDismissal` action |

Reused without modification:
- `src/main/updater-fallback.ts` — `compareVersions()`
- `src/main/updater-changelog.ts` — pattern reference for `net.fetch`
- `src/renderer/src/components/UpdateCard.tsx` — no changes

## Verification

1. **Unit tests** for `updater-nudge.ts`:
   - `satisfiesVersionConstraint`: `<1.1.20` vs `1.1.19` (true), `1.1.20` (false), `1.1.21` (false); `<=1.1.20` vs `1.1.20` (true)
   - `shouldNudge`: returns false when nudge ID matches `lastSeenNudgeId`; returns false when version doesn't match
2. **Integration**: mock `nudge.json` in existing `updater-events` tests, verify `updater:clearDismissal` is sent when nudge matches
3. **Manual**: set up local nudge.json, dismiss update card, trigger check, verify card re-appears
4. **Regression**: run existing `updater.test.ts`, `updater-events.test.ts`, `updater.check-failure.test.ts`

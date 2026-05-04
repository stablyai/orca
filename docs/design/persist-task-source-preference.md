# Design: Persist Task Source Preference (GitHub / Linear)

## Problem

The Tasks button in the sidebar always defaults to GitHub when clicked without an explicit source. If a user switches to Linear inside the Task page, that choice is lost when they navigate away and return. Users who primarily use Linear must switch every time.

## Goal

Remember which task source (GitHub or Linear) the user last selected and default to it the next time they open the Tasks page without an explicit source override.

## Current Behavior

1. **SidebarNav.tsx** — The main Tasks button calls `openTaskPage()` with no arguments. The small GitHub/Linear icons call `openTaskPage({ taskSource: 'github' })` or `openTaskPage({ taskSource: 'linear' })` respectively.

2. **ui.ts (store)** — `openTaskPage(data = {})` stores `data` into `taskPageData`. No `taskSource` field is persisted.

3. **TaskPage.tsx (line 597)** — Initializes source with `useState<TaskSource>(pageData.taskSource ?? 'github')`. The hardcoded `'github'` fallback is the root cause.

4. **TaskPage.tsx (line 1259)** — In-page source toggle calls `setTaskSource(source.id)` — local state only, never persisted.

## Proposed Solution

Piggyback on the existing `GlobalSettings` persistence pattern already used by `defaultTaskViewPreset` and `defaultRepoSelection`.

### Changes

#### 1. `src/shared/types.ts` — Add setting field

Add `defaultTaskSource: 'github' | 'linear'` to the `GlobalSettings` type, alongside the existing `defaultTaskViewPreset` field (~line 818). Use the inline union (matching the existing `taskPageData` pattern in `ui.ts`) rather than importing the file-local `TaskSource` alias from TaskPage.

#### 1b. `src/shared/constants.ts` — Add default value

Add `defaultTaskSource: 'github'` to the `GlobalSettings` defaults object (adjacent to `defaultTaskViewPreset: 'all'` ~line 158).

#### 2. `src/renderer/src/components/TaskPage.tsx` — Read and write the preference

**Read (line 597):** Change the fallback from the hardcoded `'github'` to the persisted setting:

```ts
// Before
const [taskSource, setTaskSource] = useState<TaskSource>(pageData.taskSource ?? 'github')

// After
const defaultTaskSource = settings?.defaultTaskSource ?? 'github'
const [taskSource, setTaskSource] = useState<TaskSource>(pageData.taskSource ?? defaultTaskSource)
```

**Sync effect (after line 606):** `settings` may be `null` on first render (async hydration). Add a sync effect so the persisted preference applies once settings arrive, mirroring the existing `pageData.taskSource` sync pattern on lines 602-606:

```ts
// Why: settings load asynchronously — the useState initializer may
// capture null settings on fast navigation. Sync once settings arrive,
// but only when no explicit source was passed via sidebar icon click.
useEffect(() => {
  if (!pageData.taskSource && settings?.defaultTaskSource) {
    setTaskSource(settings.defaultTaskSource)
  }
}, [settings?.defaultTaskSource, pageData.taskSource])
```

**Write (line 1259):** When the user toggles the source inside the page, persist the choice:

```ts
// Before
onClick={() => setTaskSource(source.id)}

// After
onClick={() => {
  setTaskSource(source.id)
  void updateSettings({ defaultTaskSource: source.id }).catch(() => {
    toast.error('Failed to save default task source.')
  })
}}
```

This mirrors the exact pattern used by `handleSetDefaultTaskPreset` (line 859-868).

#### 3. Settings initialization / migration

Wherever `GlobalSettings` defaults are constructed (the main process settings loader), add `defaultTaskSource: 'github'` so existing users get the current behavior with no migration needed. The field is optional in the type — missing means `'github'`.

### No changes needed

- **SidebarNav.tsx** — No changes. The main Tasks button continues to call `openTaskPage()` with no `taskSource`. The explicit GitHub/Linear icons continue to pass their source. TaskPage handles the default resolution.
- **ui.ts store** — No changes. `taskPageData` remains ephemeral. The preference is a setting, not UI state.
- **Prefetch logic** — The prefetch in `openTaskPage` and `SidebarNav` only warms GitHub work items. This is fine — Linear fetches are fast and don't benefit from the same prefetch pattern. Optionally, we could skip the GitHub prefetch when the saved source is Linear, but that's a separate optimization.

## Behavior Matrix

| Action | Result |
|---|---|
| Click main Tasks button (no saved pref) | Opens GitHub (backward-compatible default) |
| Click main Tasks button (saved pref = linear) | Opens Linear |
| Click GitHub icon in sidebar | Opens GitHub (does not change saved preference) |
| Click Linear icon in sidebar | Opens Linear (does not change saved preference) |
| Toggle source inside TaskPage | Switches view, saves new preference |
| Fresh install / no setting | Defaults to `'github'` |

## Scope

- ~20 lines of code across 3 files (`types.ts`, `constants.ts`, `TaskPage.tsx`)
- No new IPC channels
- No migrations
- No UI changes — only behavior change is remembering the last choice

## Resolved Questions

1. **Should clicking the sidebar GitHub/Linear icons also persist the preference?** No — sidebar icons are pure navigation ("go to GitHub tasks" / "go to Linear tasks"). Persisting from a one-off exploratory click would surprise users. Only the in-page toggle persists, keeping the mental model clean: sidebar icons = navigate, in-page toggle = set preference.

2. **Should we skip GitHub prefetch when saved source is Linear?** Deferred to a follow-up. The prefetch is cheap and doesn't hurt.

# Design: Linear Team Selector

## Problem

The GitHub Tasks view has a multi-repo selector dropdown that lets users scope issues to specific repositories. The Linear Tasks view has no equivalent — issues are fetched workspace-wide with no way to filter by team. Users in organizations with many teams see a noisy, unscoped list.

## Goal

Add a team multi-selector to the Linear Tasks view, matching the UX pattern of the existing GitHub repo selector (RepoMultiCombobox). Users can scope Linear issues to specific teams, and the selection persists across sessions.

## Current Behavior

1. **GitHub view** — `RepoMultiCombobox` at TaskPage.tsx:1294 lets users multi-select repos. Selection persisted via `defaultRepoSelection` in `GlobalSettings`. Hidden when Linear tab is active.

2. **Linear view** — No team scoping. `listIssues()` fetches workspace-wide via `client.issues()` or `viewer.assignedIssues()` etc. Issues include `team: { id, name, key }` on each item. No `listTeams()` API endpoint exists.

3. **Linear API** — Team metadata fetchers exist (`getTeamStates`, `getTeamLabels`, `getTeamMembers`) but all require a `teamId`. No workspace-level team enumeration is exposed.

## Proposed Solution

Client-side team filtering, deriving the team list from fetched issues. This avoids adding new IPC channels or Linear API calls.

### Approach: Derive Teams from Fetched Issues

Extract unique teams from the `LinearIssue[]` returned by existing `listIssues`/`searchIssues` calls. Build a `Map<teamId, { id, name, key }>` from `issue.team` on every fetch. Use this as the options list for a multi-select dropdown, then filter the displayed issues by selected team IDs.

**Why client-side:** The Linear SDK's `client.issues()` already returns issues across all teams the viewer can access. Adding a `listTeams()` API would require a new IPC channel, a new SDK call, and a separate loading state — all for data we already have embedded in every issue. The tradeoff is that teams with zero issues in the current filter won't appear in the selector, but that's actually desirable (no empty options).

### Changes

#### 1. `src/shared/types.ts` — Add setting field

Add `defaultLinearTeamSelection: string[] | null` to `GlobalSettings`, following the same nullable-array pattern as `defaultRepoSelection`:
- `null` = sticky-all (all teams selected, including teams that appear in future fetches)
- `string[]` = frozen subset of team IDs

#### 2. `src/shared/constants.ts` — Add default value

Add `defaultLinearTeamSelection: null` to the defaults object. New users see all teams (matching current behavior).

#### 3. `src/renderer/src/components/TaskPage.tsx` — Team selector UI + filtering

**Derive team list from issues:**

```ts
const availableTeams = useMemo(() => {
  const map = new Map<string, { id: string; name: string; key: string }>()
  for (const issue of linearIssues) {
    if (!map.has(issue.team.id)) {
      map.set(issue.team.id, issue.team)
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}, [linearIssues])
```

**Selection state:** Initialize from `settings?.defaultLinearTeamSelection`. On mount, `availableTeams` is empty (issues haven't loaded yet), so the initializer starts with an empty set for sticky-all. The sync effect below corrects this once issues arrive:

```ts
const defaultLinearTeamSelection = settings?.defaultLinearTeamSelection
const [linearTeamSelection, setLinearTeamSelection] = useState<ReadonlySet<string>>(() => {
  if (!defaultLinearTeamSelection) return new Set<string>()
  return new Set(defaultLinearTeamSelection)
})
```

**Sync effect:** Handles two cases when `availableTeams` changes (e.g., preset switch, search, initial load):

1. **Sticky-all mode** (`defaultLinearTeamSelection === null`): auto-include all discovered teams.
2. **Explicit-selection mode**: prune selected IDs to the intersection with `availableTeams`. If the intersection is empty, fall back to all teams (same recovery pattern as the repo selector at TaskPage.tsx:552-577).

```ts
useEffect(() => {
  if (availableTeams.length === 0) return
  const availableIds = new Set(availableTeams.map((t) => t.id))

  if (!defaultLinearTeamSelection) {
    // Sticky-all: always match the full available set
    setLinearTeamSelection(availableIds)
    return
  }

  // Explicit selection: prune to intersection with available teams
  const pruned = new Set([...linearTeamSelection].filter((id) => availableIds.has(id)))
  if (pruned.size === 0) {
    // All selected teams disappeared (e.g., preset switch) — recover to all
    setLinearTeamSelection(availableIds)
    void updateSettings({ defaultLinearTeamSelection: null }).catch(() => {
      toast.error('Failed to save team selection.')
    })
  } else if (pruned.size !== linearTeamSelection.size) {
    setLinearTeamSelection(pruned)
  }
}, [availableTeams, defaultLinearTeamSelection, linearTeamSelection])
```

**Filter displayed issues:**

```ts
const filteredLinearIssues = useMemo(
  () => linearIssues.filter((issue) => linearTeamSelection.has(issue.team.id)),
  [linearIssues, linearTeamSelection]
)
```

**Render substitution sites:** Replace `linearIssues` with `filteredLinearIssues` at these locations in TaskPage.tsx:
- The `.map()` that renders Linear issue rows (~line 1823)
- The no-results empty state check (~line 1811) — but add a distinct message when `linearIssues.length > 0 && filteredLinearIssues.length === 0` ("No issues match the selected teams")
- Keep the initial loading check (`linearLoading && linearIssues.length === 0`) as-is since it's about the fetch, not filtering

**Render the dropdown:** Reuse the `RepoMultiCombobox` pattern but with team data. Since the component is repo-specific (uses `Repo` type, repo dot badges), create a lightweight `TeamMultiCombobox` or generalize the existing component.

Recommendation: Create a `TeamMultiCombobox` component that mirrors `RepoMultiCombobox` but takes `teams: { id, name, key }[]` instead of `repos: Repo[]`. The trigger label shows team keys (e.g., "ENG, DES, +2") which are short and recognizable in Linear.

Place it inside the same `w-[200px]` container that wraps the repo selector, so only one is visible at a time and layout does not shift during tab switches:

```tsx
<div className="w-[200px]">
  {taskSource === 'github' ? (
    <RepoMultiCombobox ... />
  ) : availableTeams.length > 1 ? (
    <TeamMultiCombobox
      teams={availableTeams}
      selected={linearTeamSelection}
      onChange={(next) => {
        setLinearTeamSelection(next)
        void updateSettings({ defaultLinearTeamSelection: [...next] }).catch(() => {
          toast.error('Failed to save team selection.')
        })
      }}
      onSelectAll={() => {
        setLinearTeamSelection(new Set(availableTeams.map((t) => t.id)))
        void updateSettings({ defaultLinearTeamSelection: null }).catch(() => {
          toast.error('Failed to save team selection.')
        })
      }}
    />
  ) : null}
</div>
```

**Conditional rendering:** Only show the team selector when there are 2+ teams. Single-team workspaces don't need a selector.

#### 4. `src/renderer/src/components/ui/team-multi-combobox.tsx` — New component

Mirror `repo-multi-combobox.tsx` with these differences:
- Props: `teams: { id: string; name: string; key: string }[]` instead of `repos: Repo[]`
- Trigger label: team keys ("All teams" / "ENG" / "ENG, DES" / "ENG, DES, +1")
- List items: team name with key badge (e.g., "Engineering  ENG")
- Same minimum-1-selected enforcement
- Same sticky "All teams" row at top

#### 5. Test fixtures

Add `defaultLinearTeamSelection: null` to `GlobalSettings` mocks in:
- `src/main/codex-accounts/runtime-home-service.test.ts`
- `src/main/codex-accounts/service.test.ts`

### No changes needed

- **Linear API layer** — No new IPC channels or API calls. Teams are derived from existing issue data.
- **linear.ts store slice** — No changes to fetch logic.
- **SidebarNav.tsx** — No changes.

## Behavior Matrix

| Action | Result |
|---|---|
| Open Linear view (no saved pref) | All teams shown (sticky-all) |
| Select specific teams | Issues filtered, selection persisted |
| Click "All teams" | Resets to sticky-all (future teams auto-included) |
| Single-team workspace | Team selector hidden |
| Search Linear issues | Teams derived from search results; selection still applies |
| Switch preset (All/My Issues/Created/Completed) | Teams re-derived from new results; selection preserved |

## Known Limitations (v1)

1. **Team list is fetch-window-dependent.** Teams are derived from the current issue results (capped at `WORK_ITEM_LIMIT`). Teams that only appear in issues beyond the limit are invisible in the selector. This is acceptable because the most-active teams surface naturally. If user feedback shows this is a problem, a fast-follow can add `client.teams()` to fetch the full team list — a clean incremental addition that doesn't require reworking the v1 architecture.

2. **Preset switch can change available teams.** Switching from "All Issues" to "My Issues" may return a different set of teams. If the user had explicitly selected Team X (present in "All Issues") but Team X has no assigned issues, the filtered list shows nothing. The selector still displays "Team X" as selected — this is the same behavior as the GitHub repo selector when a repo has no matching issues for the current preset.

## Edge Cases

1. **Saved team IDs no longer appear in results** — The sync effect prunes explicit selections to the intersection with available teams. If all selected teams disappear (e.g., preset switch), the selection falls back to all-teams and persists `null`. This mirrors the repo selector's pruning logic at TaskPage.tsx:552-577.

2. **Empty filtered list (team filter)** — When `linearIssues.length > 0` but `filteredLinearIssues.length === 0`, show a distinct empty state: "No issues match the selected teams" with a hint to adjust the selector. This is different from the "no issues found" state which indicates the fetch itself returned nothing.

3. **Team discovered after initial load** — In sticky-all mode, newly-discovered teams are auto-included via the sync effect. In explicit-selection mode, new teams are excluded (user must opt in).

## Scope

- ~150 lines: new `TeamMultiCombobox` component (~80 lines), TaskPage changes (~50 lines), types/constants (~20 lines)
- No new IPC channels
- No new API calls
- 1 new component file

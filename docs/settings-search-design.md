# Settings Search — Design Document

## Problem

Orca's settings UI currently has no search capability. Users must manually browse through separate panes (General, Appearance, Terminal, Shortcuts, Repository) to find the setting they want. As the number of settings grows, this becomes increasingly painful.

## Research & Alternatives

### 1. The VS Code Approach (Heavyweight)

VS Code uses a multi-provider architecture (TF-IDF, Embeddings, Local Search) with complex scoring, fuzzy matching, and metadata filtering.
_Pros_: Scales to thousands of settings. _Cons_: Massive over-engineering for an app with ~25 settings.

### 2. The Flat Registry + Pane Auto-Navigation (Original Proposal)

Maintain a separate JSON/JS array of all settings. When the user types, the UI auto-navigates to the first pane containing a match.
_Pros_: Simple substring search. _Cons_: **Jarring UX**. The entire screen changes underneath the user mid-keystroke as the "first match" shifts from the General pane to the Terminal pane. Also suffers from **Data Drift**—developers must remember to update a separate registry file when they rename a UI label.

### 3. Single-Page Continuous Scroll + Component-Level Filtering (The Winner)

Instead of distinct pages that replace each other, all settings are rendered in a single continuously scrolling list, grouped by section. The sidebar acts as a Table of Contents (anchor links).
Search is handled locally at the component level. If a setting doesn't match the query, it hides itself. If a section has no visible settings, the section header hides itself.
_Pros_: Silky smooth UX (no page jumping), native feel (like Discord, Linear, or macOS Settings), and zero data drift.

## Decision

We will implement **Alternative 3: Single-Page Continuous Scroll with Component-Level Filtering**.

At our scale (~25 settings), this provides the absolute best user experience. It avoids jarring layout shifts during search, natively supports a global empty state, and keeps the codebase highly maintainable.

## Design

### 1. Layout Architecture (Single-Page)

We will refactor the Settings layout from a "Router/Tab" model to a "ScrollSpy" model:

- The right-hand content area renders `<GeneralPane />`, `<AppearancePane />`, `<TerminalPane />`, etc., all stacked vertically in a single `overflow-y-auto` container.
- The left-hand sidebar contains the Search Input at the top, and a list of anchor links below it.
- Clicking a sidebar link smoothly scrolls the right-hand container to that section.

### 2. State Management

We only need to track the search query in the Zustand store.

```typescript
type SettingsSlice = {
  settings: GlobalSettings | null
  settingsSearchQuery: string // NEW
  setSettingsSearchQuery: (q: string) => void // NEW
  // ... existing methods
}
```

### 3. Component-Level Filtering (No separate registry)

To prevent the search index from drifting away from the UI, search metadata is colocated with the UI component itself.

We introduce a `<SearchableSetting>` wrapper component. Every setting control in the UI is wrapped in this.

```tsx
interface SearchableSettingProps {
  title: string
  description?: string
  keywords?: string[]
  children: React.ReactNode
}

export function SearchableSetting({
  title,
  description,
  keywords,
  children
}: SearchableSettingProps) {
  const query = useSettingsStore((s) => s.settingsSearchQuery).toLowerCase()

  if (query) {
    const matchesTitle = title.toLowerCase().includes(query)
    const matchesDesc = description?.toLowerCase().includes(query)
    const matchesKw = keywords?.some((k) => k.toLowerCase().includes(query))

    if (!matchesTitle && !matchesDesc && !matchesKw) {
      return null // Hide this setting if it doesn't match
    }
  }

  return (
    <div className="setting-row">
      {/* Title, description, and children (the actual input control) */}
    </div>
  )
}
```

### 4. Section Visibility & Empty States

If all `<SearchableSetting>` components inside `<TerminalPane />` return `null`, the Terminal pane will be empty.

To handle this cleanly:

- We can track section matches via a lightweight Context, OR
- Since React renders top-down, we can simply apply CSS: `div:empty { display: none }` or use a `useMemo` to check visibility of children arrays if data-driven.
- For the easiest React implementation: a `SettingsSection` wrapper that reads the query, knows its children's search metadata, and hides its own `<h2>` header if no children match.

**Global Empty State:**
If the overall `searchQuery` yields 0 matches across the entire settings page, we display a clear centered message in the main content area:
`No settings found for "{query}"`

### 5. File Changes

```text
src/renderer/src/components/settings/
  Settings.tsx                    — Add search input, change layout to stacked scroll
  SearchableSetting.tsx           — NEW: Wrapper component for filtering
  SettingsSection.tsx             — NEW: Wrapper for sections to hide headers
  panes/
    GeneralPane.tsx               — Wrap items in <SearchableSetting>
    AppearancePane.tsx            — Wrap items in <SearchableSetting>
    TerminalPane.tsx              — Wrap items in <SearchableSetting>
    ShortcutsPane.tsx             — Wrap items in <SearchableSetting>
    RepositoryPane.tsx            — Wrap items in <SearchableSetting>
```

### 6. Workflow for Adding New Settings

When a developer adds a new setting, they simply wrap it in `<SearchableSetting title="..." keywords={['...']}>`.
Because the UI component _is_ the search index, it is impossible for the setting to exist in the UI but be missing from the search logic, guaranteeing long-term maintainability.

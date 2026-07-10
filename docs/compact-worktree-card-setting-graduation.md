# Compact Worktree Card Setting Graduation

## Problem

`experimentalCompactWorktreeCards` is exposed in two places: the Experimental settings pane and the
sidebar workspace options menu. The sidebar menu already presents the durable user-facing model as
`Card layout` with `Detailed` and `Compact`, so the Experimental row is redundant and makes the same
preference look like two separate features.

## Goal

Graduate the preference out of Experimental. Keep the sidebar workspace options menu as the
canonical control, preserve existing users' saved compact-card choice, and remove the Experimental
pane row/search entry.

## Non-goals

- Do not change worktree card compact layout behavior.
- Do not redesign the workspace options menu.
- Do not remove workspace card property or agent activity layout controls.
- Do not change SSH, provider metadata, prompt-cache, conflict, or port behavior.

## Design

1. Add `compactWorktreeCards` to `GlobalSettings` and defaults.
2. Preserve backward compatibility by hydrating `compactWorktreeCards` from legacy
   `experimentalCompactWorktreeCards` when the new field is absent.
3. Update sidebar/worktree-card reads and writes to use `compactWorktreeCards`.
4. Remove the Experimental pane row and search entry for `Compact worktree cards`.
5. Keep the legacy optional type field only as a read-only migration input.

## Data Flow

- Persistence loads settings with defaults.
- If `compactWorktreeCards` is missing, persistence copies the old
  `experimentalCompactWorktreeCards` value, falling back to the default.
- The sidebar `Card layout` menu writes `compactWorktreeCards`.
- `WorktreeCard` reads `settings?.compactWorktreeCards === true`.

## Edge Cases

- Old profiles with `experimentalCompactWorktreeCards: true` still render compact cards.
- Old profiles with the flag missing still default to detailed cards.
- Search in Settings no longer finds a duplicate Experimental result.
- Compact-card behavior remains unchanged for metadata rows, unread placement, main-worktree
  marker, SSH icons, prompt-cache state, conflicts, sparse checkout badges, and inline agents.

## Test Plan

- Update default-settings tests for `compactWorktreeCards`.
- Add a persistence migration test for legacy `experimentalCompactWorktreeCards`.
- Update Experimental pane tests to assert the row/search entry is absent.
- Update WorktreeCard tests to set `compactWorktreeCards`.
- Run focused tests for constants, persistence, ExperimentalPane, and WorktreeCard compact behavior.

## UI Quality Bar

The Experimental pane should simply omit the redundant row without leaving spacing gaps. The
workspace options menu should continue to show `Card layout` with `Detailed` and `Compact`.

## Review Screenshots

1. Experimental pane without `Compact worktree cards`.
2. Sidebar workspace options menu still showing `Card layout`.

## Rollout

1. Add the new setting and legacy hydration.
2. Update card/menu consumers.
3. Remove the Experimental pane/search entry.
4. Update focused tests.
5. Validate the two visible settings surfaces.

## Lightweight Eng Review

- Scope: kept to one setting graduation; no card layout behavior changes.
- Architecture/data flow: existing settings persistence remains the boundary; renderer consumers read
  the new key, persistence bridges legacy profiles.
- Failure modes covered:
  - Existing compact users losing the preference: migration copies the legacy flag.
  - Duplicate settings search result: Experimental search entry is removed.
  - Renderer/main mismatch: `GlobalSettings`, defaults, and consumers are updated together.
- Test coverage required:
  - `src/shared/constants.test.ts` for the default.
  - `src/main/persistence.test.ts` for legacy hydration.
  - `src/renderer/src/components/settings/ExperimentalPane.test.tsx` for removal.
  - Existing WorktreeCard tests updated to the new key.
- Performance/blast radius: no new IPC, polling, file watching, or provider work.
- UI quality bar: Experimental pane has no orphan row; sidebar card layout control remains present.
- Required review screenshots:
  1. Experimental pane without the compact-card toggle.
  2. Sidebar workspace options menu with `Card layout`.
- Residual risks: old profiles may keep the legacy key on disk until settings are next saved, but
  runtime behavior uses the migrated value.

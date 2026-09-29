# Sketch: generic `--needs-attention` hook (real files, real patterns)

Traced the full real path a `worktree set` flag takes, end to end, so this
sketch follows their exact existing pattern rather than inventing a new one:

```
src/cli/handlers/worktree.ts      ('worktree set' — parses flags, calls RPC)
  → src/main/runtime/rpc/methods/worktree-schemas.ts   (WorktreeSet zod schema)
    → src/main/runtime/rpc/methods/worktree.ts          ('worktree.set' RPC method)
      → runtime.updateManagedWorktreeMeta(...)          (persists + notifies renderer)
        → src/shared/types.ts                           (Worktree data type)
          → src/renderer/.../WorktreeCardStatusSlot.tsx  (sidebar rendering)
```

## 1. CLI flag (`src/cli/handlers/worktree.ts`)

Follow the exact tri-state pattern already used for `--linear-issue`
(`getOptionalLinearIssueLinkFlag(flags, 'linear-issue', { allowNull: true })`
— "pass `null` to clear" is already a documented, precedented contract, not
something new to design):

```ts
// 'worktree set' handler, alongside the existing comment/workspaceStatus lines:
needsAttention: getOptionalNullableStringFlag(flags, 'needs-attention'),
```

Usage would read exactly like the existing linear-issue clear contract:
```
orca worktree set --worktree <selector> --needs-attention "PR #996: 1 unresolved thread"
orca worktree set --worktree <selector> --needs-attention null   # clear
```

## 2. Schema (`src/main/runtime/rpc/methods/worktree-schemas.ts`)

One line, next to `linkedLinearIssue`'s identical shape:

```ts
needsAttention: z.union([z.string(), z.null()]).optional(),
```

**Bonus finding, unrelated to this feature but worth a separate tiny PR**:
`comment` uses `OptionalPlainString`, specifically *not* `OptionalString`,
because (per their own comment on `displayName`) `OptionalString` treats an
empty string as "not provided" and drops it — exactly the
`--comment ""`-is-a-no-op quirk our own tool worked around with a
single-space hack. This looks like a real, narrow, easily-reproducible bug
in the CLI's flag-parsing layer (`getOptionalStringFlag` for `comment`
specifically), not intended behavior — the schema clearly wants to support a
genuine empty comment. Worth its own small PR separately; do not conflate it
with this one.

## 3. RPC handler (`src/main/runtime/rpc/methods/worktree.ts`)

One line inside the existing `updateManagedWorktreeMeta` call (~line 214):

```ts
comment: params.comment,
needsAttention: params.needsAttention,   // new
workspaceStatus: params.workspaceStatus,
```

## 4. Data model (`src/shared/types.ts`)

Add `needsAttention: string | null` next to `comment: string` on the
managed-worktree type (there are three sibling shapes with this field
pattern at lines ~341/496/624 — `FolderWorkspace` and presumably the git
`Worktree` + a persisted-record type; add it to whichever of those actually
carries `linkedPR` too, to keep it scoped to git worktrees specifically
rather than folder workspaces, which don't have PRs to react to).

## 5. Rendering (`WorktreeCardStatusSlot.tsx` + a new small component)

Deliberately **not** reusing `StatusIndicator`'s `permission` case
(`MessageCircleQuestion`, amber) — that's the agent-needs-input bell, and
`#4893` just finished making it mean exactly one thing. Also not reusing the
PR `ReviewIcon` lane — this hook is provider-agnostic, not GitHub-specific,
so it shouldn't visually pretend to be a PR icon either.

New minimal component, e.g. `NeedsAttentionIndicator.tsx`, one reserved
token (`--status-warning`, already added by `#4893` — no new color to
design), one shape not already in use in this row (a small filled triangle
or flag glyph — needs an actual design-review opinion, not mine to pick
unilaterally). Rendered in `WorktreeCardStatusSlot` alongside the existing
slot logic:

```ts
{worktree.needsAttention && (
  <NeedsAttentionIndicator reason={worktree.needsAttention} />
)}
```

Tooltip shows the reason string verbatim — no truncation/parsing, it's an
opaque caller-provided string, same posture as `comment`.

## Scope for a first PR

- CLI flag + schema + RPC + data model + one small rendering component +
  tests mirroring `WorktreeCardStatusSlot.test.tsx`'s existing structure.
- No settings/toggle, no per-provider awareness, no polling of anything —
  Orca does zero new fetching. The caller (us, or anyone) decides when to
  set/clear it and why.
- Explicitly out of scope: making this override the `QUIET_REVIEW_REPLACEABLE_STATUSES`
  gating (i.e. whether it should show even while an agent is actively
  working) — same open question as the native-approach sketch had, worth
  raising in the PR description rather than deciding unilaterally.

## What this means for `orca-pr-watch.py`

If this lands: swap `spawn_fake_waiting_terminal`'s entire hook-spoofing
apparatus (the harvested `ORCA_AGENT_HOOK_*` env vars, the fabricated
`PermissionRequest` payload, the sleeping throwaway terminal) for one plain,
documented, stable CLI call:

```
orca worktree set --worktree "id:<wt_id>" --needs-attention "PR #<n> — <reason>"
```

Straight simplification — same `comment` field keeps carrying the detail
text it already does (or this could subsume it entirely, TBD), but the
signal itself stops depending on undocumented internals that could break on
any Orca update.

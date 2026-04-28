# Design: Close the typecheck hole in `src/preload/*.d.ts`

**Status**: Draft
**Author**: brennanb2025
**Date**: 2026-04-27
**Related**: #1186 (landed, broke worktree creation), #1189 (revert/fix), issue #624

## Context

### Scope note

**The `StartFromField.tsx` crash described below is already fixed on `main` via #1189.**
This doc is not about fixing that specific regression — it's about closing the
typecheck hole that let the regression ship in the first place. The incident is
the case study; the fix is preventive, aimed at the class of failure (silent
`any`-widening on the preload IPC surface), not the individual bug.

### The incident (already fixed)

On 2026-04-27, PR #1186 ("fix: support upstream remote as base ref for fork workflows")
merged to `main` and immediately broke the **Create Worktree** flow with React error #31
(`Objects are not valid as a React child`). The regression was reverted/patched by
#1189 the same day.

The PR changed the `repos:getBaseRefDefault` IPC return from
`Promise<string | null>` to `Promise<BaseRefDefaultResult>` (envelope
`{ defaultBaseRef: string | null; remoteCount: number }`). Two of the three renderer
call sites were updated; one — `src/renderer/src/components/new-workspace/StartFromField.tsx`
— was not. That file still ran `setDefaultBaseRef(ref)` where `setDefaultBaseRef` was
typed `Dispatch<SetStateAction<string | null>>` and `ref` was now the envelope object.
The envelope flowed into JSX and threw at render time.

The author missed it because:

1. No caller audit after merging `main` into the branch — `StartFromField.tsx` was
   introduced by #1078 mid-way through #1186's lifetime, and the breaking IPC shape
   change was treated as a local-files change instead of a public-contract change.
2. Manual Electron testing exercised `BaseRefPicker` and `SourceControl` but never
   opened the New Workspace dialog.
3. **`pnpm run typecheck` passed cleanly on the broken code**, which is what this
   design doc is about.

### Why typecheck didn't catch it

`setDefaultBaseRef(someEnvelopeObject)` in a renderer file where the setter is
typed `Dispatch<SetStateAction<string | null>>` **should be a TypeScript compile
error**. A minimal reproduction of the same pattern (explicit `Promise<BaseRefDefaultResult>.then(...)`)
does error as expected. But inside the actual call — `window.api.repos.getBaseRefDefault(...).then((ref) => ...)` —
TypeScript resolves `ref` to `any`, so any downstream assignment is silently accepted.

This was verified with `IsAny<T>` probes inside a debug file:

```ts
type IsAny<T> = 0 extends (1 & T) ? true : false

// Isolated Promise — ref correctly typed as BaseRefDefaultResult
declare const p: Promise<BaseRefDefaultResult>
p.then((ref) => {
  const yes: IsAny<typeof ref> = true   // ERRORS: cannot assign true to false
  const no: IsAny<typeof ref> = false
})

// Through window.api — ref resolves to any
window.api.repos.getBaseRefDefault({ repoId: 'x' }).then((ref) => {
  const yes: IsAny<typeof ref> = true   // passes
  const no: IsAny<typeof ref> = false   // passes
})
```

The root cause: **`src/preload/index.d.ts` references ~20 type names it never
imports**. Examples: `Worktree`, `WorktreeMeta`, `PRInfo`, `IssueInfo`,
`PRCheckDetail`, `PRComment`, `GlobalSettings`, `CliInstallStatus`,
`NotificationDispatchRequest`, `NotificationDispatchResult`, and others. Running
`tsc --skipLibCheck false` surfaces all of them:

```
src/preload/index.d.ts(49,47): error TS2304: Cannot find name 'Worktree'.
src/preload/index.d.ts(99,72): error TS2304: Cannot find name 'PRInfo'.
src/preload/index.d.ts(132,17): error TS2304: Cannot find name 'PRCheckDetail'.
src/preload/index.d.ts(154,22): error TS2304: Cannot find name 'GlobalSettings'.
... (20+ lines)
```

With **`skipLibCheck: true`** (inherited from `@electron-toolkit/tsconfig`), TypeScript
processes `.d.ts` files for declaration merging but **skips error reporting on them**.
The 20+ unresolved type names silently become `any`. The `ReposApi` type in this file
is built from partly-resolved, partly-`any` method signatures.

When that broken `ReposApi` is intersected with `PreloadApi['repos']` to form
`window.api.repos`, TypeScript's intersection-of-function-types resolution widens
the `.then` callback parameter to `any` at the call site, even though static-inspection
views (`ReturnType<typeof fn>`) still report the correct `Promise<BaseRefDefaultResult>`.
So `setDefaultBaseRef(ref)` where `ref: any` passes — `any` is assignable to
`Dispatch<SetStateAction<string | null>>`.

### Why `skipLibCheck: true` is set

It's not set by us. It lives in `@electron-toolkit/tsconfig/tsconfig.json`, a
third-party config this project extends. That config has been a dev dependency since
the initial commit (`224ab0b1`, 2026-03-16, Neil) — it was scaffolded in when the
project was generated from the **electron-vite** starter template, and never
re-evaluated.

`skipLibCheck: true` is the industry-standard default for Node / Electron / Vite
projects. It exists so broken `.d.ts` files in random `node_modules` packages don't
block your builds. The tradeoff is that TypeScript doesn't distinguish between
"don't check other people's `.d.ts`" and "don't check my own `.d.ts`" — so
project-owned `.d.ts` files get the same free pass.

This tradeoff is almost always fine because the standard pattern is that
project-owned type declarations live in `.ts` files (which are always checked) and
`.d.ts` files are reserved for ambient shims (`vite/client.d.ts`, `env.d.ts`).
**Orca is an outlier**: `src/preload/index.d.ts` is a 250-line project-owned
declaration file with actual IPC contract definitions, not a shim. It violates the
assumption the flag was designed around.

## Goal

Close the typecheck hole so future contract changes to IPC signatures fail
CI when a caller isn't updated, without regressing build times or introducing
spurious errors from third-party `.d.ts` files.

## Non-goals

- Re-fix the `StartFromField.tsx` crash — already handled by #1189.
- Add E2E coverage for every IPC consumer (separate work, owned by E2E suite).
- Generally tighten TypeScript strictness (e.g., `noUncheckedIndexedAccess`) —
  unrelated to this bug class.
- Rip out `@electron-toolkit/tsconfig` — it does legitimate work for `node_modules`,
  and removing it would need a careful audit of every dep's `.d.ts`.
- Add contract-test frameworks, type-level IPC assertions, or similar ceremony.
- Redesign the preload surface. This doc is about type-checking what we already have.

## Proposal

One structural change, plus two defense-in-depth layers. `skipLibCheck`
*exposed* the hole, but the real architectural flaw is that two hand-authored
views of the same IPC contract — `src/preload/index.d.ts` and
`src/preload/api-types.d.ts` — were kept in sync only by accident. Delete
the duplicate; the `skipLibCheck` problem goes away with it.

### 1. Collapse the two preload type files into a single, type-checked source

In one PR:

- **Delete `src/preload/index.d.ts`.** This is the duplicate-drift surface. Its
  `ReposApi` / `WorktreesApi` / `PtyApi` / etc. types overlap the corresponding
  members of `PreloadApi` in `api-types.d.ts`, and the
  `Api = PreloadApi & { repos: ReposApi, … }` intersection is what let the two
  views of the same method appear aligned while producing different callable
  behavior at the `window.api.*` call site. Removing it removes the hole.
- **Rename `src/preload/api-types.d.ts` → `src/preload/api-types.ts`.**
  `skipLibCheck` skips `.d.ts` files wholesale (there is no way to scope it to
  `node_modules`), so project-owned type files must live in `.ts` to get
  checked. The content is already a regular TypeScript module — nothing
  about the rename changes runtime behavior.
- **Move any still-needed members from the deleted `index.d.ts` into
  `api-types.ts`** as part of `PreloadApi`. No more intersection type; a single
  `PreloadApi` is the full contract.
- **Update the `declare global { interface Window { api: Api } }`** declaration
  to use `PreloadApi` directly instead of the now-gone `Api` alias.
- **Add the ~20 missing imports** (`Worktree`, `WorktreeMeta`, `PRInfo`,
  `IssueInfo`, `PRCheckDetail`, `PRComment`, `GlobalSettings`,
  `CliInstallStatus`, `NotificationDispatchRequest`,
  `NotificationDispatchResult`, …) from `src/shared/types.ts`. These types
  already exist; they were just never imported because `.d.ts` let them
  silently resolve to `any`.
- **Fix every typecheck error that surfaces in the same PR.** Do not defer.
  The errors that appear are exactly the bugs `skipLibCheck` has been hiding
  — splitting the rename from the fixes would leave `main` red or require a
  revert.
- **Update `config/tsconfig.web.json:7` and `config/tsconfig.tc.web.json:7`**
  so the `include` lists the renamed file by exact path:
  `"../src/preload/api-types.ts"` (not a `**/*` glob). The current glob is
  `.d.ts`-specific and will miss the renamed file; a `**/*` replacement would
  sweep `src/preload/index.ts` (the runtime preload, imports from
  `'electron'`) into the web typecheck and produce a new wave of "Cannot find
  module 'electron'" errors in a lib that's DOM-only. Explicit path is safest.

**Contract reconciliation.** Collapsing the intersection is *not* purely
additive: `PreloadApi` and the `*Api` aliases in `index.d.ts` have genuinely
different fields on a handful of methods, and the
`Api = PreloadApi & { repos: ReposApi, … }` intersection lets each side's
fields survive today. Delete `index.d.ts` naively and each side loses what
only the other had. Before deleting, run a field-level diff between the
`*Api` aliases and the corresponding `PreloadApi` members and reconcile each
divergence. Known cases:

- `PtyApi.spawn.shellOverride?: string` (`src/preload/index.d.ts:71`) is
  absent from `PreloadApi.pty.spawn` (`api-types.ts:347-359`). Callers at
  `src/renderer/src/components/terminal-pane/pty-transport.ts:356` and
  `pty-connection.ts:277` pass it, and the runtime `src/preload/index.ts`
  supports it. **Merge INTO `PreloadApi.pty.spawn`.**
- `PreloadApi.pty.onReplay` (`api-types.ts:380`) is absent from `PtyApi`;
  the intersection currently surfaces it to `window.api.pty`. Already on the
  surviving side — **verify it survives the collapse** (the renderer dispatcher
  at `pty-dispatcher.ts:54` uses it).
- `PreloadApi.gh.listWorkItems.before` (optional pagination param,
  `api-types.ts:420`) is absent from `GhApi.listWorkItems`
  (`index.d.ts:121-125`). Already on the surviving side — **no action**, but
  verify renderer callers still compile.

Grep for any other divergence not yet enumerated; the list above is what was
caught on a first pass, not a proof of exhaustiveness.

Cost: ~1 day of mechanical work plus however long the surfaced errors take to
fix. Zero runtime risk — the file only contains type declarations.

Prevention value: closes the exact gap that caused #1186. A future PR that
changes an IPC return shape without updating all callers will fail
`pnpm run typecheck`, because `PreloadApi` is now the single, type-checked
source of truth for `window.api`.

### 2. CI already runs `pnpm typecheck`; no workflow change needed

For the avoidance of doubt: `.github/workflows/pr.yml:55` already runs
`pnpm typecheck` on every PR. Once the structural fix in (1) lands, errors
previously silenced by `skipLibCheck` will begin surfacing in CI
automatically, and any maintainer watching red checks will catch regressions.
No new workflow step and no branch-protection enforcement rule is being
added here — the explicit direction is to rely on the existing check.

### 3. Mechanical guard against new project-owned `.d.ts` files

Add a CI step (grep or oxlint rule) that fails the build if any file matches
`src/preload/**/*.d.ts` or `src/shared/**/*.d.ts`. Given the scan roots, no
current file requires allowlisting — the ambient shims in the tree
(`env.d.ts`, `mermaid.d.ts`, `hosted-git-info.d.ts`) all live outside
`src/preload/` and `src/shared/`. If a future file under those roots
genuinely needs to be `.d.ts` (an ambient module shim for a third-party
package that can't live in `.ts`), add it to an allowlist at that time.

Simplest form: a one-step grep in `.github/workflows/pr.yml`, e.g.
`! find src/preload src/shared -name '*.d.ts' | grep .`.
Implementation detail is left to the implementer; the requirement is that
re-introducing a project-owned `.d.ts` in `src/preload` or `src/shared`
fails CI with a message pointing at this design doc.

Prevention value: stops the next person from recreating the drift surface by
adding a new `.d.ts` that re-opens the `skipLibCheck` hole under a new name.

### 4. Document the `.d.ts` vs `.ts` convention

Add a short note to `CONTRIBUTING.md` / `AGENTS.md` / both:

> Project-owned type declarations belong in `.ts` files. `.d.ts` is reserved
> for ambient shims (e.g., `env.d.ts`, `vite/client.d.ts`). TypeScript's
> `skipLibCheck: true` setting applies globally, including to our own `.d.ts`
> files, which means any unresolved type reference in a `.d.ts` silently
> becomes `any` at its call sites. Write your types in `.ts` files so the
> compiler actually checks them.

Cost: ~15 minutes. Defense-in-depth for the humans; (3) is the same defense
for the machines.

## Architecture

Before — two hand-authored views of the same contract, joined by an
intersection type, with `skipLibCheck` hiding the divergence:

```
 src/preload/index.d.ts          src/preload/api-types.d.ts
 ┌────────────────────────┐      ┌──────────────────────────┐
 │ ReposApi {             │      │ PreloadApi {             │
 │   getBaseRefDefault:   │      │   repos: {               │
 │     (…) => Promise<…>  │      │     getBaseRefDefault:   │
 │   …                    │      │       (…) => Promise<…>  │
 │ }                      │      │     …                    │
 │ WorktreesApi { … }     │      │   }                      │
 │ PtyApi { … }           │      │   worktrees: { … }       │
 │                        │      │   pty: { … }             │
 │ type Api =             │      │ }                        │
 │   PreloadApi & {       │      └──────────────────────────┘
 │     repos: ReposApi,   │                 ▲
 │     worktrees: …,      │─────────────────┘
 │     pty: …             │   (intersection merges — silently
 │   }                    │    widens to `any` when names in
 │                        │    index.d.ts fail to resolve and
 │ declare global {       │    skipLibCheck suppresses the error)
 │   interface Window {   │
 │     api: Api           │
 │   }                    │
 │ }                      │
 └────────────────────────┘
     (20+ unimported names → any under skipLibCheck)
```

After — one file, one type, checked by `tsc`:

```
 src/preload/api-types.ts
 ┌──────────────────────────────────────┐
 │ import {                             │
 │   Worktree, WorktreeMeta, PRInfo,    │
 │   IssueInfo, PRCheckDetail, …        │
 │ } from '../shared/types'             │
 │                                      │
 │ export interface PreloadApi {        │
 │   repos: {                           │
 │     getBaseRefDefault:               │
 │       (…) => Promise<                │
 │         BaseRefDefaultResult>        │
 │     …                                │
 │   }                                  │
 │   worktrees: { … }                   │
 │   pty: { … }                         │
 │ }                                    │
 │                                      │
 │ declare global {                     │
 │   interface Window {                 │
 │     api: PreloadApi                  │
 │   }                                  │
 │ }                                    │
 └──────────────────────────────────────┘
       (single source of truth;
        unresolved names are hard errors)
```

## Alternatives considered

### A. Disable `skipLibCheck` globally

Set `"skipLibCheck": false` in the local tsconfigs, overriding the inherited
base. **Rejected, and subsumed by the structural fix.** Disabling it globally
would require every third-party `@types/*` package to type-check cleanly on
every compilation. Even well-maintained packages ship `.d.ts` files with
warnings or inter-package inconsistencies; one broken transitive dep would
block the whole build. This is exactly the reason the ecosystem-wide default
is `true`. Once project-owned declarations live in `.ts` (proposal §1),
there's no project-owned `.d.ts` for `skipLibCheck` to hide errors in,
so the global setting becomes moot.

### B. Add a second tsconfig that only checks our own `.d.ts` files

Create a separate `tsconfig.lib-check.json` that has `skipLibCheck: false` and
an `include` list of only `src/**/*.d.ts`. Run both tsconfigs in
`pnpm run typecheck`. **Rejected, and subsumed by the structural fix.** Adds a
new tool-maintenance surface for a class of problem the single-source-of-truth
rewrite solves directly. No second tsconfig to keep in sync, and errors show
up in the normal typecheck rather than a special one.

### C. Build a contract-test layer that validates IPC shape at runtime

Wire up `zod` or similar schemas to the preload boundary so shape mismatches
throw typed errors at runtime. **Rejected (out of scope).** Runtime shape
validation is a separate, larger discussion. It's worth having, but it's not
the fix for "typecheck didn't work" — that's still a typecheck problem even if
runtime validation exists.

### D. Add E2E coverage for the Create Worktree flow

**Deferred, not rejected.** Worth doing, but this is about defense in depth at
a different layer. The typecheck fix prevents this class of bug from ever
reaching an E2E test; the E2E test prevents it from reaching a user. Both
valuable, separate work. Other reviewers have flagged the E2E gap and it should
be picked up as its own PR.

### E. Single source of truth via `PreloadApi` (adopted)

Delete `index.d.ts`, rename `api-types.d.ts` → `api-types.ts`, and have
`window.api` typed directly as `PreloadApi`. **Adopted — see Proposal §1.**
This is the structural fix: the drift surface is gone, and `skipLibCheck`'s
effect on project code is gone with it. Pays for itself the first time a
future IPC signature changes.

### F. Infer `Api` from `typeof api`

Instead of hand-authoring the type at all, derive it from the runtime object:
`export type Api = typeof api` in `src/preload/index.ts`, and have the
renderer consume that. **Rejected for now.** The current implementation still
has a lot of `Promise<unknown>` and manually-cast `ipcRenderer.invoke` calls,
so `typeof api` would bake those weak types into the renderer's view of the
surface — strictly worse than the hand-authored `PreloadApi`. This becomes
the right end state once the runtime is strengthened (proper generics on the
`invoke` wrapper, typed channel map). Filed as a follow-up, not a blocker.

### G. Constrain `index.ts` by `PreloadApi`

Keep the runtime `api` object in `index.ts` but assert
`const api: PreloadApi = { … }` (or a `satisfies` clause) so the runtime
implementation is proven against the contract. **Deferred.** This is the
correct long-term direction — it closes the remaining gap between the
type-level contract and the runtime factory — but it's meaningfully more
invasive than the single-PR fix proposed here and risks expanding the blast
radius. Filed as a follow-up once (E) lands and stabilizes.

### H. Pre-push hook that runs `pnpm typecheck`

Gate pushes locally via husky. **Rejected.** User explicitly opted against
adding enforcement at the pre-push layer; CI already runs typecheck on every
PR (§2), which is sufficient. Pre-push would shift cost to every contributor
for a check that already runs server-side.

## Rollout

- **PR 1** (same day as this doc): the structural fix in one shot.
  - Delete `src/preload/index.d.ts`.
  - Rename `src/preload/api-types.d.ts` → `src/preload/api-types.ts`.
  - Move any still-needed members into `PreloadApi`; drop the
    `Api = PreloadApi & { … }` intersection; retarget the `Window.api`
    declaration to `PreloadApi`.
  - Add the ~20 missing imports from `src/shared/types`.
  - Fix every typecheck error that surfaces (do not defer — splitting the
    rename from the fixes would leave `main` red).
  - Update `config/tsconfig.web.json` and `config/tsconfig.tc.web.json` so
    their `include` lists the renamed file by exact path
    (`"../src/preload/api-types.ts"` — see §1 for why a `**/*` glob is wrong).
  - Acceptance test: `pnpm run typecheck` is green on CI (which already
    runs it — §2).
  - Add the mechanical guard from §3 (grep-or-oxlint check against new
    `src/preload/**/*.d.ts` and `src/shared/**/*.d.ts`) in the same PR so
    the fix can't regress.
- **Docs update** (same PR or an immediate follow-up): append the `.d.ts`
  convention note from §4 to `CONTRIBUTING.md` / `AGENTS.md`.

## Open questions

- Are the `*Api` member aliases in `index.d.ts` (`ReposApi`, `WorktreesApi`,
  `PtyApi`, …) still referenced anywhere outside `index.d.ts`? Grep before
  deleting — if anything imports them, those imports need to be retargeted
  at the corresponding member type on `PreloadApi` as part of the same PR.
- ~~Does `config/tsconfig.web.json`'s `include` need to change from the
  `.d.ts`-specific glob (line 7)?~~ **Settled (see Proposal §1):** replace
  the glob at `config/tsconfig.web.json:7` and `config/tsconfig.tc.web.json:7`
  with the exact path `"../src/preload/api-types.ts"`. A `**/*` replacement
  would pull `src/preload/index.ts` (which imports from `'electron'`) into
  the DOM-only web typecheck.
- Is there a generator or codegen step that writes `api-types.d.ts`? A quick
  grep suggests no, but if yes we'd need to retarget the output to `.ts`.
- Are there other project-owned `.d.ts` files with the same hole?
  `src/renderer/src/env.d.ts`, `src/renderer/src/mermaid.d.ts`, and
  `src/main/types/hosted-git-info.d.ts` are legitimate ambient shims that
  live outside the §3 scan roots (`src/preload/` and `src/shared/`), so no
  allowlist is needed. Anything new under those roots is caught by the
  mechanical guard in §3.

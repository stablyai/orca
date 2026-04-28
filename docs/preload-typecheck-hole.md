# Preload typecheck hole: why project-owned types live in `.ts`

## The rule

Project-owned type declarations under `src/preload/` and `src/shared/`
**must live in `.ts` files, not `.d.ts`**. The CI step
"Guard against project-owned .d.ts in preload/shared" in
`.github/workflows/pr.yml` enforces this.

## Why

Orca inherits `skipLibCheck: true` from `@electron-toolkit/tsconfig`.
That setting is the ecosystem default — it exists so a broken `.d.ts`
in some random `node_modules` package can't block your build. TypeScript
has no way to scope it to `node_modules`, so **`skipLibCheck`
applies to our own `.d.ts` files too**.

In a project-owned `.d.ts`, any type reference that fails to resolve
silently becomes `any` at its call sites instead of erroring. Downstream
assignments against that `any` are also silently accepted. The error
never surfaces during `pnpm typecheck`.

For example, with `skipLibCheck: true`:

```ts
// in src/preload/index.d.ts — Worktree is never imported
type WorktreesApi = {
  list: () => Promise<Worktree[]>  // silently becomes Promise<any[]>
}
```

and at the call site:

```ts
// in any renderer file
window.api.worktrees.list().then((arr) => {
  setWorktreeName(arr)  // setWorktreeName expects string; accepted anyway because arr is any[]
})
```

No compile error. Crashes at runtime.

The standard TS convention that sidesteps this: put project-owned types in
`.ts` (which are always checked), reserve `.d.ts` for ambient shims
(`env.d.ts`, `vite/client.d.ts`, etc.). The CI guard encodes that
convention mechanically.

## Incident that forced the fix

PR #1186 changed the `repos:getBaseRefDefault` IPC return shape from
`Promise<string | null>` to `Promise<BaseRefDefaultResult>` (an envelope
object). Two of three renderer callers were updated; the third
(`StartFromField.tsx`) wasn't. That caller passed the envelope object
into a `setState<string | null>` setter, which rendered as JSX and threw
React error #31 (`Objects are not valid as a React child`).

**The call site should have been a compile error.** It wasn't, because
`src/preload/index.d.ts` (now deleted) was a 246-line project-owned
`.d.ts` that referenced ~20 type names it never imported (`Worktree`,
`PRInfo`, `GlobalSettings`, `BaseRefDefaultResult`, and more). Under
`skipLibCheck`, each unresolved name became `any`, which widened the
`.then((ref) => …)` callback parameter to `any` at the consuming call
site. `setDefaultBaseRef(ref: any)` compiled cleanly.

The crash is fixed by #1189. The typecheck hole is fixed by this PR
(#1197), which collapses the two preload type files (`index.d.ts` +
`api-types.d.ts`) into a single type-checked `api-types.ts`. Full design
discussion, alternatives considered, and rollout notes live in PR #1197.

## Non-obvious subtleties worth remembering

- **It's not the hand-authored types that failed — it was the missing
  imports.** The types in the old `index.d.ts` were individually fine;
  the file only went wrong because names like `Worktree` and `PRInfo`
  weren't imported and `skipLibCheck` swallowed the error. A future
  contributor copy-pasting types out of a `.d.ts` into `.ts` may be
  surprised by a wall of "Cannot find name 'X'" errors — that's the
  flag catching its target, not a real regression.
- **`.d.ts` is still legitimate for ambient shims.** `env.d.ts`,
  `mermaid.d.ts`, `hosted-git-info.d.ts` all live *outside* the CI
  guard's scan roots (`src/preload/` and `src/shared/`) and stay as
  `.d.ts`. If a future file under those roots genuinely needs to be
  `.d.ts` (e.g., an ambient module shim for a third-party package that
  can't live in `.ts`), add it to an allowlist in `pr.yml` at that
  time — don't relax the guard wholesale.
- **Intersection types on `window.api` are what actually widened the
  `.then` callback to `any`.** The old layout used
  `type Api = PreloadApi & { repos: ReposApi, worktrees: WorktreesApi, … }`.
  TypeScript's intersection-of-function-types resolution widens callback
  parameters to `any` when one side of the intersection has unresolved
  names, *even though static-inspection views
  (`ReturnType<typeof fn>`) still report the correct type*. So
  `ReturnType<typeof window.api.repos.getBaseRefDefault>` printed
  `Promise<BaseRefDefaultResult>` during debugging while the live
  `.then((ref) => …)` callback treated `ref` as `any`. Don't re-introduce
  intersection typing on the preload surface for any reason.
- **Don't try to fix this by flipping `skipLibCheck: false` globally.**
  It would force every transitive `@types/*` package to type-check
  cleanly, which is why the ecosystem-wide default is `true`. The
  structural fix (project-owned types in `.ts`) removes our last
  reason to care about the flag for our code.

---
phase: 1
title: "Scaffold and Driver Deps"
status: done
effort: "S"
---

# Phase 1: Scaffold and Driver Deps

## Overview

Stand up the empty `Database` top-level view, add the `pg`/`mysql2` driver deps,
and prove they are **copied into the packaged app** and lazy-import cleanly on all
3 OSes. No real DB behavior yet — this de-risks packaging first, because Orca does
**not** bundle main-process deps into the asar.

## Requirements

- Functional: a `Database` entry in the sidebar opens a placeholder full-screen view.
- Non-functional: drivers resolvable via `await import(...)` from the main process
  **in a packaged build**, not only in dev; not present in the renderer eager bundle;
  no native rebuild step required.

## Architecture

New top-level view kind `'database'` added to the `activeView` union, routed to a
lazy-loaded `DatabasePage`, opened by a sidebar nav button.

**Packaging reality (red-team F1):** `electron.vite.config.ts` externalizes main
deps (`externalizeDeps`, ~`:174`), so `pg`/`mysql2` stay as bare runtime imports.
The packaged app only ships an **explicit allowlist** of runtime node_modules —
`PACKAGED_RUNTIME_PACKAGE_ROOTS` in `config/packaged-runtime-node-modules.cjs`
(~`:8-25`) — copied and then checked by `verifyPackagedMainRuntimeDeps` in
`electron-builder.config.cjs` `afterPack` (~`:130`). Drivers absent from that list
= `MODULE_NOT_FOUND` at runtime (or a hard `afterPack` throw). They must be added.

**Lazy-import precedent (red-team F4):** the correct model is the main-process
dynamic import `await import('@parcel/watcher')` in
`src/main/ipc/filesystem-watcher.ts:296` (externalized + allowlisted), **not** the
renderer `MermaidBlock.tsx` code-split. The verifier scans for `require("…")`; the
emitted form of an externalized dynamic `import()` may be `import(...)` and slip the
regex — so confirm the emitted output and that the packaged app actually resolves
the module.

## Related Code Files

- Create: `src/shared/database-types.ts` (stub: `DbEngine = 'postgres' | 'mysql'`).
- Create: `src/renderer/src/components/database/DatabasePage.tsx` (placeholder shell).
- Modify: `src/renderer/src/store/slices/ui.ts` — add `'database'` to the
  `activeView` union (~`:547`) + `setActiveView` handling (mirror `'skills'`).
- Modify: `src/renderer/src/App.tsx` — lazy import + route `activeView === 'database'`
  → `<DatabasePage />` (mirror `SkillsPage` lazy route ~`:279`/`:2262`).
- Modify: sidebar — add a DB nav button (mirror `SidebarTaskNavButton.tsx`),
  lucide `Database` icon, STYLEGUIDE tokens, platform-correct shortcut label.
- Modify: `package.json` — add `pg`, `mysql2`, `@types/pg`.
- **Modify: `config/packaged-runtime-node-modules.cjs`** — add `'pg'` and `'mysql2'`
  to `PACKAGED_RUNTIME_PACKAGE_ROOTS` (red-team F1). The graph walk pulls mysql2's
  transitive deps (denque, lru-cache, named-placeholders, sqlstring, …).
- Modify: `config/electron-builder.config.cjs` — only if a packaged smoke test shows
  asar unpack is additionally needed (expected: allowlist copy is sufficient).

## Implementation Steps

1. `pnpm add pg mysql2 && pnpm add -D @types/pg`.
2. Add `'database'` to `activeView` union + setter in `ui.ts`.
3. Create `DatabasePage.tsx` placeholder (empty state, shadcn primitives, tokens).
4. Lazy-route it in `App.tsx`; add the sidebar nav button (no hardcoded `⌘`).
5. Add `database-types.ts` stub.
6. Add `pg`/`mysql2` to `PACKAGED_RUNTIME_PACKAGE_ROOTS`.
7. Smoke-test lazy import **in a packaged build**: `await import('pg')` /
   `import('mysql2/promise')` resolves from the packaged app (not just dev); confirm
   `verifyPackagedMainRuntimeDeps` passes; confirm emitted require/import form. Remove
   the temp probe after.
8. Confirm drivers are **absent from the renderer eager bundle** by checking the
   main-process startup require graph excludes them until first connect (red-team F4)
   — do not rely on a renderer cold-start diff, which passes trivially for main-only deps.

## Success Criteria

- [ ] `Database` view opens empty from the sidebar; typecheck + lint pass.
- [ ] **Packaged** build resolves `pg`/`mysql2` at runtime; `verifyPackagedMainRuntimeDeps`
      green on macOS/Linux/Windows (red-team F1).
- [ ] Drivers not loaded in the main-process startup require graph until first connect.
- [ ] No `electron/rebuild` needed (pg/mysql2 are pure-JS — confirmed).

## Risk Assessment

- `mysql2` optional native bits (compression/crypto) — confirm it loads without them;
  document any disabled optional feature.
- Externalized dynamic `import()` may emit a form the `require()`-only verifier misses,
  yielding a silent prod `MODULE_NOT_FOUND` — step 7 must test the **packaged** app,
  not dev.

## Red Team Hardening (applied)

- **F1 (Critical):** add `pg`/`mysql2` to `config/packaged-runtime-node-modules.cjs`
  allowlist; success criterion = packaged `verifyPackagedMainRuntimeDeps` on 3 OSes.
- **F4 (Medium):** re-anchored lazy-import to main-process `filesystem-watcher.ts:296`;
  replaced the meaningless renderer cold-start check with a main-process require-graph
  assertion; confirm `import()` vs `require()` emission.

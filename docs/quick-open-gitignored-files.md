# Quick Open Gitignored Files

## Problem

Cmd/Ctrl+P Quick Open does not list arbitrary gitignored files in the active workspace.

- `src/renderer/src/components/QuickOpen.tsx:257` calls `window.api.fs.listFiles(...)`; filtering in the renderer only fuzzy-matches the returned list, so missing files are already absent from the backend result.
- `src/main/ipc/filesystem-list-files.ts:46` uses `buildRgArgsForQuickOpen(...)` for local worktrees, then merges the primary rg pass with `envPass`.
- `src/relay/fs-handler-list-files.ts:37` uses the same shared rg args for SSH worktrees.
- `src/shared/quick-open-filter.ts:252` builds the primary rg pass without `--no-ignore-vcs`, so gitignored files are hidden.
- `src/shared/quick-open-filter.ts:265` builds a second `--no-ignore-vcs` pass, but it is restricted to `.env*` and `**/.env*`.
- `src/shared/quick-open-filter.ts:357` builds the git fallback primary pass with `--exclude-standard`; `src/shared/quick-open-filter.ts:365` only adds `.env*` pathspecs.

## Root Cause

Quick Open intentionally mirrors `rg --files --hidden` with gitignore respect, then adds a special-case pass for gitignored `.env*` files. That policy lives in shared code used by local main-process listing, SSH relay listing, and git fallback listing, so non-env ignored files are excluded consistently in every workspace type.

## Non-goals

- Do not change right-sidebar text search behavior.
- Do not add a new UI preference or mode switch.
- Do not follow symlinks or broaden traversal outside the authorized workspace root.
- Do not surface heavy generated directories already excluded by Quick Open policy, including `node_modules`, `.git`, `.cache`, `.next`, and other `HIDDEN_DIR_BLOCKLIST` entries.
- Do not change fuzzy ranking, selection, file-opening behavior, or shortcut handling.

## Design

1. Replace the `.env*` rg second pass with a general ignored-files pass.
   - Keep `--files --hidden --no-ignore-vcs`, hidden-dir blocklist globs, nested-worktree exclude globs, `searchRoot='.'`, and path-separator handling.
   - Remove positive `.env*` globs so the second pass is no longer a whitelist.
   - Keep the primary pass unchanged.

2. Rename pass naming from `envPass` to `ignoredPass` in shared/main/relay code.
   - This is a behavior change, not cosmetic: the second pass now returns all gitignored candidates.

3. Replace git fallback `.env*` pass with ignored-files pass.
   - Keep primary as `['--cached', '--others', '--exclude-standard', ...]`.
   - Use ignored pass as `['--others', '--ignored', '--exclude-standard', ...]`.
   - Keep nested-worktree pathspec exclusion semantics (`--`, `.`, excludes when exclude prefixes exist).
   - Do not assume both runtimes have identical error semantics today:
     - local main fallback currently resolves on most git failures;
     - relay fallback rejects on spawn/signal failures.
     Preserve each runtime’s current behavior unless explicitly changing it in a separate doc.

4. Keep post-filters unchanged.
   - `shouldIncludeQuickOpenPath` remains final blocklist enforcement.
   - `shouldExcludeQuickOpenRelPath` remains nested-worktree correctness backstop.
   - Set-based merge still dedupes cross-pass overlap.

5. Do not change renderer request-lifecycle logic in this doc.
   - Current `QuickOpen.tsx` effect cleanup cancels the prior request before the next effect body runs.
   - This change is backend listing policy only.

6. Update tests.
   - `quick-open-filter.test.ts`: assert rg ignored pass has `--no-ignore-vcs` and no `.env*` globs; assert git ignored pass has `--others --ignored --exclude-standard` and no `.env*` pathspec whitelist.
   - `filesystem-list-files.test.ts`: update pass-detection helpers that currently key off `'**/.env*'`; cover ignored non-env files; keep local fallback’s resolve-on-failure behavior unchanged.
   - Add relay coverage in `src/relay/fs-handler.test.ts` (or new focused relay tests) for ignored-pass args and current reject-on-signal behavior.

## Edge Cases

- Gitignored files inside `node_modules`, `.git`, `.cache`, `.next`, `.npm`, `.npm-global`, `.gvfs`, and other blocklisted dirs must remain hidden.
- Nested linked worktree paths passed as `excludePaths` must remain excluded from both rg and git passes.
- Local/SSH candidate sets should match when both run the same backend path (rg or git) and complete successfully; timeout/error behavior remains intentionally different today.
- Windows and WSL path normalization must remain unchanged; output still passes through `normalizeQuickOpenRgLine`.
- If rg is unavailable, git fallback should include ignored files only when Git can enumerate them; non-git roots keep existing fallback limits.
- Timeout/signal behavior must not regress into partial false-empty results.
- Keep existing timeout asymmetry unless intentionally changed: local rg/git fallback uses 10s timeouts, relay rg uses 25s.
- `--no-ignore-vcs` also includes files ignored by parent/global excludes; blocklists are the guardrail against accidental heavy trees.

## Rollout

1. Update `src/shared/quick-open-filter.ts` types, rg args, git args, and comments.
2. Update local main-process and SSH relay callers/tests for `ignoredPass`.
3. Run focused tests for quick-open filters and list-files (main + relay).
4. Run `pnpm typecheck` and `pnpm lint`.
5. Validate in Electron on local + SSH worktrees with gitignored non-env files and nested linked worktrees.

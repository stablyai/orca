# WSL Native Project Support — Design

- **Date:** 2026-07-11
- **Status:** Proposed
- **Approach:** A — surface the existing WSL routing as a first-class project source (no new execution host)
- **Related issues:** #5311 (P1 stub — superseded by this design), #5111 (per-project shell), #6908, #7021, #7649, #6331
- **Related PR:** #7968 (managed Linux file-watching host — reused, not blocked on)

## 1. Problem & Motivation

Orca fully supports running a **WSL shell**, but a **project** is only ever a Windows-hosted
entity. A repo that lives inside the WSL filesystem is registered as a Windows **UNC path**
(`\\wsl.localhost\<distro>\home\<user>\<repo>`) and treated as a transparent routing sub-mode of
the `local` host. There is no first-class "open a WSL project" entry point, the file explorer
surfaces UNC paths instead of the native POSIX path, and the WSL shell pivot depends on
`cwd`-string sniffing rather than the project's resolved runtime.

Compared to VSCode's WSL Remote — which the user identifies as the closest-to-native Windows
experience — this is inconvenient, and it has produced a recurring class of path-translation bugs
(#6908 UI/CLI ref mismatch, #7021 Windows separators passed to WSL git, #7649 "Open in VS Code"
resolves to Windows, #6331 UNC cwd `DaemonProtocolError`).

**Goal:** make a WSL-filesystem project a first-class, user-selectable source in **Add Project**
(a peer of `Local` / `SSH` in the UI, à la VSCode), with **POSIX path recognition and display**
and an **automatic WSL shell default** — while **reusing** Orca's existing WSL routing rather than
introducing a new execution host.

## 2. Scope

### In scope
- A **"WSL" source** in the Add Project flow: distro detection + POSIX filesystem browsing.
- **POSIX display** of the project path in the file explorer / titles, plus a **`WSL: <distro>`
  indicator badge** (VSCode remote-indicator parallel).
- **WSL default-shell pivot** driven by the *resolved runtime*, with a **per-project shell
  override** (absorbs #5111).
- **Close the worktree-base watching gap** for WSL roots so new worktrees appear in the explorer.
- **Unify UI and CLI repo-add normalization** so both resolve identical Git refs (addresses #6908).

### Out of scope / non-goals
- **No new `ExecutionHostId`** (`wsl:<distro>`). WSL stays a `local` sub-mode (Approach A, not B).
  Rationale: the runtime resolver already threads `wslDistro` through every Git call; a full
  provider (SSH-style) would duplicate that layer and fight the team's existing architecture.
- **No change to canonical storage.** `Repo.path` remains the UNC form (every Windows `fs` code
  path depends on a Windows-readable path); POSIX is a **display/identity derivation only**.
- **WSL over SSH** (a remote host that itself runs WSL) is not addressed.
- Rich terminal POSIX file-link clickability (#8156) is adjacent; tracked separately unless the
  reviewer wants it folded in.

## 3. Existing architecture (context for reviewers)

- **Host taxonomy** — `src/shared/execution-host.ts`: `ExecutionHostId = 'local' | 'ssh:${string}'
  | 'runtime:${string}'`. WSL is intentionally **absent**; a WSL repo is a `local` host.
- **Runtime resolver (the real WSL/host boundary)** — `src/shared/project-execution-runtime.ts`:
  `LocalWindowsRuntimePreference = inherit-global | windows-host | wsl{distro}`;
  `resolveProjectExecutionRuntime()` resolves project → global → a runtime or a `repair-required`
  state (`wsl-unavailable`, `wsl-distro-missing`, …). `src/main/local-project-runtime-resolution.ts`
  wires it to the store (gated on `getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID`).
  `src/main/project-runtime-git-options.ts` returns `{ cwd, wslDistro? }` and **throws on repair
  state** (never silently falls back to host git).
- **Git routing** — `src/main/git/runner.ts` `resolveCommand()`: on win32, when `cwd` is a WSL UNC
  path or a `wslDistroOverride` is present, rewrites to
  `wsl.exe -d <distro> -- bash -c "cd '<linux>' && git …"` with all path args translated
  (`translateArgsForWsl`, and `translateWslOutputPaths` for the reverse).
- **Path layer** — `src/shared/wsl-paths.ts` (`parseWslUncPath`) + `src/main/wsl.ts`
  (`parseWslPath`, `toLinuxPath`, `toWindowsWslPath`, `listWslDistrosAsync`, `getDefaultWslDistro`,
  `getWslHome`, `isWslAvailable`, `wslUncDirectoryExists`). Handles both `\\wsl.localhost\` and
  legacy `\\wsl$\`.
- **File watching** — `src/main/ipc/filesystem-watcher.ts` branches
  `isWslPath ? createWslWatcher : createWatcher`. WSL watching runs *inside* the distro
  (`filesystem-watcher-wsl.ts`; being upgraded by PR #7968). **Worktree-base watching is disabled
  for WSL roots** at `src/main/ipc/worktree-base-directory-watch-targets.ts:131`.
- **Worktree mirroring** — new WSL worktrees are mirrored inside the distro (`~/orca/workspaces`)
  via `getWslHome()` in `src/main/ipc/worktree-logic.ts` (`shouldMirrorWorkspaceDirInsideWsl`).
- **Terminal shell** — `src/main/providers/local-pty-provider.ts` (and daemon mirror
  `src/main/daemon/pty-subprocess.ts`, shared `windows-shell-args.ts`) set `shellPath='wsl.exe'`
  when the cwd is a WSL path.

## 4. Design

### 4.1 Data model & identity
- A WSL project is a `Repo` with `path` = UNC, `connectionId = null` (local), and
  `localWindowsRuntimePreference = { kind: 'wsl', distro }` **set explicitly at add time** — so
  routing no longer depends on incidental `cwd` path-sniffing (root cause of #6908).
- Add two small derivations (no schema change):
  - `getRepoDisplayPath(repo): string` — returns the POSIX path for WSL repos via `parseWslUncPath`,
    else `repo.path`. Display-only.
  - `isWslRepo(store, repo): boolean` — **runtime-based** predicate that centralizes the scattered
    `isWslPath(cwd)` checks behind one source of truth.

### 4.2 Add Project flow (WSL source)
- Add-project source selector gains **`WSL`** alongside `Local` / `SSH`.
- On `WSL`: detect distros with `listWslDistrosAsync()`, default to `getDefaultWslDistro()`, and
  show a clear empty/disabled state when WSL is unavailable (`isWslAvailable()`).
- Browse the chosen distro's filesystem in **POSIX form**; on selection convert to UNC with
  `toWindowsWslPath` for storage, and validate existence with `wslUncDirectoryExists()` (Win32
  `fs.statSync` lies over the 9P filesystem).
- The repo-add IPC branches for WSL the way it branches for SSH (`src/main/ipc/repos.ts`), setting
  the runtime preference — giving the **same normalized identity as the CLI `repo add`** path
  (#6908).

### 4.3 Display layer (VSCode-style distinction)
- File-explorer tree root, window/tab title, and path chips use `getRepoDisplayPath` (POSIX).
- Project/repo rows show a **`WSL: <distro>` badge**, mirroring VSCode's remote indicator, so the
  UI distinction the user asked for is visible without changing internal storage.

### 4.4 Shell pivot (absorbs #5111)
- New-terminal default shell is decided from the **resolved runtime**, not a `cwd` string match:
  if the runtime is `wsl{distro}`, default to that distro's WSL login shell.
- Add a **per-project "Default Shell" override**. Resolution precedence:
  **explicit creation override > per-project override > runtime-based default (WSL) > global setting.**
- Threaded through the existing spawn path (`local-pty-provider.ts` /
  `daemon/pty-subprocess.ts` / shared `windows-shell-args.ts`) — no new spawn pipeline.

### 4.5 Gap closures
- **Enable worktree-base watching for WSL roots**: remove the skip at
  `worktree-base-directory-watch-targets.ts:131` and route WSL roots through the in-distro watcher
  (`filesystem-watcher-wsl.ts`, aligned with PR #7968) so newly created worktrees surface in the
  explorer without a manual refresh.
- **Unify repo-add normalization** (UI == CLI) to prevent separator/ref bugs (#6908, #7021 class).

### 4.6 Edge cases & error handling
- WSL not installed / not running / distro removed → surfaced through the resolver's
  `repair-required` states (`wsl-unavailable`, `wsl-distro-missing`) with a UI repair affordance.
  Preserve the existing behavior where `getLocalProjectGitExecOptions` **throws** on repair state
  rather than silently using host Git.
- Legacy `\\wsl$\` vs modern `\\wsl.localhost\` provider prefixes are normalized at repo-add so
  watcher event-prefix matching fires (noted in PR #7968 review as a pre-existing mismatch).

### 4.7 Testing
- Unit: `getRepoDisplayPath` / `isWslRepo`, UNC↔POSIX conversion, runtime-resolve branches
  (override → global → repair), shell-precedence resolution.
- Integration: WSL add-flow parity with CLI `repo add` (#6908), worktree-base watching emits
  create events for new WSL worktrees.
- **Host scoping**: assert distro-A state does not leak into distro-B, per AGENTS.md host-scoping
  and `GitCapabilityCache` guidance. Cover first fallback, cached calls, and concurrent probes.

## 5. Rollout & risks
- **Low blast radius**: reuses the runtime resolver, path layer, Git routing, and WSL watcher.
  New surface is the add-project source, the display derivations, the shell override, and the
  watcher gap removal.
- **Risk**: display/storage split (POSIX shown, UNC stored) must be applied consistently — mitigated
  by funnelling all display through `getRepoDisplayPath` and all "is this WSL?" logic through
  `isWslRepo`.
- **Dependency**: benefits from PR #7968 but does not block on it — the current in-distro watcher
  is sufficient for correctness.

## 6. Open questions
1. Fold terminal POSIX file-link clickability (#8156) into this scope, or track separately?
2. Should the `WSL: <distro>` badge also expose a quick "change distro / repair runtime" action?
3. Per-project shell override storage: reuse `localWindowsRuntimePreference` shape or add a
   dedicated `defaultShell` field on the project?

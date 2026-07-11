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

The reference is VSCode's WSL Remote — its behavior set is well established, so we adopt it rather
than re-deriving the UX.

This spec was hardened by an independent code-grounded review (see §7); scope below reflects its
findings and the resulting decisions.

### In scope
- A **"WSL" source** in the Add Project flow (needs a source-model design first — §4.2): distro
  detection + POSIX browsing, `\\wsl$\`→`\\wsl.localhost\` normalization at add.
- **POSIX display** in the file explorer / titles, plus a **clickable `WSL: <distro>` badge**.
- **`Project.defaultShell` field + full persistence carve-outs + a settings control + main-process
  spawn wiring** (§4.4). WSL projects stay on the WSL shell; the field drives windows-host projects
  (absorbs #5111).
- **Clickable POSIX terminal file links** (#8156) — resolution (not detection) via
  `isWslRuntimeResolution`; sequenced last.
- **#6908 root-resolution unification** (diagnosis + unify UI/CLI git-root + dedup — §4.5).

### Deferred (dependency, still tracked here)
- **Worktree-base watching for WSL roots depends on PR #7968** (§4.5). This PR keeps the current skip;
  live WSL base-watching lands on #7968's managed host. New worktrees surface via manual refresh until
  then (unchanged from today).

### Out of scope / non-goals
- **No new `ExecutionHostId`** (`wsl:<distro>`). WSL stays a `local` sub-mode (Approach A, not B).
  Rationale: the runtime resolver already threads `wslDistro` through every Git call; a full
  provider (SSH-style) would duplicate that layer and fight the team's existing architecture.
- **No change to canonical storage.** `Repo.path` remains the UNC form (every Windows `fs` code
  path depends on a Windows-readable path); POSIX is a **display/identity derivation only**.
- **No mass migration** of existing `cwd`-sniffing (`git/runner.ts` etc.) — the new predicate governs
  new WSL-project code only.
- **WSL over SSH** (a remote host that itself runs WSL) is not addressed.
- **No in-place "move project to another distro."** Files live in one distro's filesystem; switching
  distros is a **reopen/re-add** (identical to VSCode's "Reopen in WSL using Distro…"), not a move.
- **`Open in VS Code` correctness (#7649)** is cited as motivating pain in §1 but tracked separately —
  not scoped into this PR.

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
- **Path layer** — `src/shared/wsl-paths.ts` (`parseWslUncPath`, `toWindowsWslPath` — the latter
  re-exported from `src/main/wsl.ts`) + `src/main/wsl.ts`
  (`parseWslPath`, `toLinuxPath`, `listWslDistrosAsync`, `getDefaultWslDistro`,
  `getWslHome`, `isWslAvailable`, `wslUncDirectoryExists`, `wslUncPathExists`). Handles both
  `\\wsl.localhost\` and legacy `\\wsl$\`.
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
- A WSL project is a `Repo` with `path` = UNC, `connectionId = null` (local), and the owning
  `Project.localWindowsRuntimePreference = { kind: 'wsl', distro }` **set explicitly at add time** —
  so the resolved runtime is deterministic (does not wait on incidental `cwd` sniffing). This is
  hygiene, **not** the #6908 fix (see §4.5 — the CLI add path that works sets no preference).
- Add two pure derivations (no `Repo` schema change):
  - `getRepoDisplayPath(path: string): string` — POSIX for WSL UNC paths via `parseWslUncPath`, else
    unchanged. Display-only. (`parseWslUncPath` normalizes back/forward slashes and both UNC prefixes.)
  - `isWslRuntimeResolution(resolution): boolean` — true when the resolved runtime kind is `'wsl'`.
    Thin store/main selectors (`isWslRepo`) wrap it. **Scope note:** this becomes the source of truth
    for the *new* WSL-project code (display, badge, shell, links). We do **not** rip out the existing
    load-bearing `cwd` sniffing in `git/runner.ts` / `local-pty-provider.ts` in this PR.
- **`Project.defaultShell` is a persisted Project field — see §4.4 for the required carve-outs.**

### 4.2 Add Project flow (WSL source)
- **The Add Project dialog is `ExecutionHostId`-keyed end-to-end** (`use-add-repo-host-selection.ts`:
  host-option state, `parseExecutionHostId`, per-host flows). Under Approach A a WSL source has no host
  id — so a **source model must be designed first** (a discriminated source union, or a `local-host`
  sub-source `{ kind: 'wsl', distro }`) before touching the UI. This is where Approach A leaks; the
  fix is UI-only (the git/runtime layer needs no new host).
- Source selector gains **`WSL`** alongside `Local` / `SSH`. On `WSL`: detect distros via a
  `wsl:listDistros` IPC (wrapping `listWslDistrosAsync()` with **refresh/bypass** semantics — the
  `wsl.ts` distro/availability caches are process-lifetime and failure-sticky, wrong for a picker
  whose repair story is "install WSL / add distro, then retry"). Default `getDefaultWslDistro()`;
  empty/disabled when `isWslAvailable()` is false.
- Browse the distro in **POSIX form** (reuse `filesystem-list-files.ts`, UNC-capable); on selection
  store UNC via **`toWindowsWslPath(linuxPath, distro)`** (note arg order) and validate with
  `wslUncDirectoryExists()`.
- Register through the local add channel (`repos:add`, not `repos:addRemote`), setting
  `localWindowsRuntimePreference = {kind:'wsl',distro}`. (Identity/#6908 parity is handled by the
  root-resolution unification in §4.5, not by the preference alone.)

### 4.3 Display layer (VSCode-style distinction)
- File-explorer tree root, window/tab title, and path chips use `getRepoDisplayPath` (POSIX).
- Project/repo rows show a **clickable `WSL: <distro>` badge**, mirroring VSCode's remote indicator
  (which opens a command menu). Behavior by state:
  - **Healthy** — badge is informational (`WSL: <distro>`, path in tooltip); clicking opens a small
    menu with reopen/settings-style entries (e.g. open runtime settings, reopen in WSL using another
    distro → routed through re-add, new WSL terminal).
  - **`repair-required`** — badge turns into an actionable recovery affordance (retry / manage
    runtime), because `getLocalProjectGitExecOptions` throws rather than falling back to host Git,
    so the user needs a non-dead-end path.

### 4.4 Default shell (absorbs #5111)
- **Dedicated `Project.defaultShell?: 'inherit' | 'powershell' | 'wsl' | 'cmd' | 'git-bash'` field**,
  independent of `localWindowsRuntimePreference` (runtime = *where* commands run; shell = *what* a new
  terminal opens with — matching VSCode's per-workspace `terminal.integrated.defaultProfile`).
- **Policy — WSL projects use the WSL shell (decision):** `defaultShell` selection (PS/cmd/git-bash)
  applies to **windows-host** projects only. For a **WSL-runtime** project the shell stays WSL — we
  **keep** the existing main-side force-WSL (`local-windows-terminal-runtime.ts`,
  `local-pty-provider.ts:375`). This sidesteps the UNC-cwd problem (cmd.exe cannot use a UNC cwd) and
  matches VSCode (a WSL window's terminal is WSL). #5111's "PowerShell vs WSL" is a *per-project*
  choice across windows-host vs WSL projects, so it is still satisfied.
- Resolution precedence (windows-host projects): **explicit creation override (allowed shells only) >
  project `defaultShell` (≠inherit) > global setting.** For WSL runtime: **WSL** (force retained).
  `repair-required` keeps returning `wsl.exe` (do **not** let creation override reverse this).
- **The spawn decision is authoritative in main, not the renderer label.** The field must be threaded
  into `src/main/ipc/pty.ts` (`resolveLocalWindowsTerminalRuntimeOptions`, ~:2923/:3640) and the
  daemon mirror (`daemon/pty-subprocess.ts`) + `windows-shell-args.ts`, not only
  `terminals.ts`/`local-windows-terminal-runtime.ts` (renderer label). A renderer-only change is
  cosmetic — main overrides it.
- **Persistence carve-outs are mandatory (Fable [CRITICAL]).** Projects are projection-derived; a new
  Project field is silently dropped unless every site that today whitelists
  `localWindowsRuntimePreference` also carries `defaultShell`: `src/main/persistence.ts` (projection
  sync ~:2355, `updateProject` ~:3774), `src/main/orca-profiles/profile-project-state-file.ts` (~:124),
  renderer merges in `src/renderer/src/store/slices/repos.ts` (~:477/:518/:594), and both update
  schemas (`project-runtime-rpc-methods.ts` `ProjectUpdate` ~:43, `ipc/repos.ts` `ProjectUpdateIpcArgs`
  ~:711) — zod strips unknown keys, so a missed schema drops the value.
- A **settings control to set `defaultShell`** (sibling of `ProjectWindowsRuntimeSetting.tsx`) is
  required — otherwise #5111 is plumbed but not usable.

### 4.5 Gap closures
- **Worktree-base watching for WSL roots — deferred to depend on PR #7968 (decision).** Base watching
  does **not** use `createWatcher`/`createWslWatcher`; it uses a stat-gated poller
  (`worktree-base-directory-poller.ts`). Naively removing the skip at
  `worktree-base-directory-watch-targets.ts:131-140` would run Win32 `realpath`/`stat` over 9P (false
  ENOENTs, per `wsl.ts:34-40`) and re-wake distros after `wsl --shutdown` — the reasons the skip
  exists. #7968 ("managed Linux watcher host") rewrites this module, so **this PR keeps the skip** and
  the in-distro base watch lands on #7968's host client afterward. Until then, newly created worktrees
  surface via manual refresh (unchanged from today).
- **`\\wsl$\` → `\\wsl.localhost\` normalization at repo-add** (concrete step): the WSL watcher emits
  events only in `\\wsl.localhost\` form, so a repo registered under the legacy `\\wsl$\` prefix never
  matches. Normalize the provider prefix at add time and handle existing legacy-prefix repos — this is
  load-bearing for dedup and for #7968 event matching.
- **#6908 is a diagnosis task, not a one-liner.** The working CLI add sets no runtime preference, so
  that is not the fix. The likely divergence is UI resolving the git root via `getGitRepoRoot` (whose
  UNC output round-trips through WSL output translation → `\\wsl$\` vs `\\wsl.localhost\` drift and the
  duplicate entries the issue reports) plus dedup via `normalizeRuntimePathForComparison`
  (`ipc/repos.ts:190-210`), vs the CLI storing the path as-given. Task must reproduce, then unify
  UI/CLI root-resolution + dedup (also covers the #7021 separator class).

### 4.6 Edge cases & error handling
- WSL not installed / not running / distro removed / no distro chosen → surfaced through the
  resolver's `repair-required` states (`wsl-unavailable`, `wsl-distro-missing`, `wsl-distro-required`)
  with a UI repair affordance.
  Preserve the existing behavior where `getLocalProjectGitExecOptions` **throws** on repair state
  rather than silently using host Git.
- Legacy `\\wsl$\` vs modern `\\wsl.localhost\` provider prefixes are normalized at repo-add so
  watcher event-prefix matching fires (noted in PR #7968 review as a pre-existing mismatch).

### 4.7 Terminal file links (#8156)
- In a WSL project's terminal, POSIX paths (`/home/u/app/src/x.ts[:line[:col]]`) become clickable and
  open the file, matching VSCode's integrated-terminal link behavior.
- **The gap is resolution, not detection.** The VSCode-ported detectors
  (`terminal-pane/terminal-link-handlers.ts` `createFilePathLinkProvider`, `lib/terminal-links.ts`)
  already extract POSIX paths (SSH terminals rely on it). The WSL work is: when the tab's project
  runtime is WSL (`isWslRuntimeResolution`), resolve the POSIX path against the repo's UNC root,
  confirm existence 9P-safely (`wslUncDirectoryExists`/runtime-path cache, not Win32 `fs`), then route
  the editor open.
- **Sequenced last** so the core (open/navigate/shell) lands and is reviewed first.

### 4.8 Testing
- Unit: `getRepoDisplayPath` / `isWslRuntimeResolution`, UNC↔POSIX conversion, runtime-resolve
  branches (override → global → repair), `defaultShell` precedence (windows-host chooses; WSL forced;
  repair keeps `wsl.exe`), POSIX terminal-link resolution.
- **Persistence: a projection-resync test proving `defaultShell` survives** (Fable [CRITICAL]).
- **SSH regression**: assert the shell change is inert for remote worktrees (`isRemoteWorktree` guard,
  `terminals.ts:302`).
- Integration: WSL add-flow parity with CLI `repo add` after root-resolution unification (#6908),
  terminal link opens the correct file in a WSL project. (Live WSL base-watching test lands with #7968.)
- **Host scoping**: assert distro-A state does not leak into distro-B, per AGENTS.md host-scoping
  and `GitCapabilityCache` guidance. Cover first fallback, cached calls, and concurrent probes.

## 5. Rollout & risks
- **Moderate blast radius** (revised after review): the read paths reuse the runtime resolver, path
  layer, and Git routing, but two areas touch shared infrastructure and carry real risk —
  (a) the `Project.defaultShell` **persistence carve-outs** (7 sites; a miss silently drops the field),
  and (b) **main-process spawn wiring** (`pty.ts` + daemon mirror) which is where the shell actually
  takes effect and where SSH/remote must not regress.
- **Risk**: display/storage split (POSIX shown, UNC stored) must be applied consistently — mitigated
  by funnelling all display through `getRepoDisplayPath` and all "is this WSL?" logic through
  `isWslRuntimeResolution`.
- **Dependency**: worktree-base watching **blocks on PR #7968**; everything else ships independently.

## 6. Resolved decisions (VSCode-aligned)
VSCode's WSL Remote is a well-established reference, so these are settled rather than left open:
1. **Terminal POSIX file-link clickability (#8156): in scope**, sequenced last and built on the
   `isWslRuntimeResolution` + POSIX-resolution primitives introduced here (§4.7). VSCode clearly provides it.
2. **`WSL: <distro>` badge: clickable/actionable** (§4.3). Healthy → informational + reopen/settings
   menu; `repair-required` → recovery action. "Change distro" is **reopen/re-add** semantics, not an
   in-place move (mirrors VSCode's "Reopen in WSL using Distro…").
3. **Per-project shell: dedicated `Project.defaultShell` field** (§4.4), independent of the runtime
   axis. **WSL projects stay on the WSL shell** (main force-WSL retained; avoids the cmd.exe UNC-cwd
   problem); the field drives windows-host projects. Requires full persistence carve-outs + a settings
   control + main-process spawn wiring (renderer-only is cosmetic).

## 7. Review history
- **2026-07-11 — independent code-grounded review (model: Fable).** Verdict: *revise-then-ship*.
  Confirmed Approach A against the code; caught (a) `defaultShell` self-erasure via projection/merge
  plumbing [CRITICAL], (b) shell decision living in main, not the renderer label [HIGH], (c) Task 7
  targeting the wrong subsystem and colliding with #7968 [HIGH], (d) the Add Project dialog being
  `ExecutionHostId`-keyed [HIGH], (e) #6908 misattribution [MED]. Decisions taken: defer watching to
  #7968; WSL projects = WSL shell only; single PR. All folded into §2/§4/§5 above.

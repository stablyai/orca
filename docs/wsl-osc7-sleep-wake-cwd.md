# WSL OSC 7 Sleep/Wake CWD

## Problem

On native Windows, a WSL terminal can persist a fake UNC current working directory and then fail to wake. The deterministic trigger is a WSL shell emitting `file://<machine-hostname>/home/...` before sleep:

- `osc7-file-uri.ts` treats every non-local authority as a UNC server when parsing Win32 paths.
- `Session` constructs its daemon `HeadlessEmulator` without the WSL execution context, so checkpoints can store `\\<machine-hostname>\home\...`.
- `OrcaRuntimeService` likewise gives every local Windows PTY Win32 OSC 7 semantics; `remotePosixAuthority` only protects POSIX SSH PTYs.
- `HistoryReader.restoreFromIncrementalLog` creates a third context-free emulator. A log containing the OSC 7 can therefore re-create the bad CWD even if the base checkpoint is valid.
- `DaemonPtyAdapter.doSpawn` prefers `restoreInfo.cwd` over the requested worktree CWD. `pty-subprocess.ts` later validates the fake UNC and rejects it before spawning WSL.

Reproduction on Windows 11 build 26200, WSL 2.3.26.0, Ubuntu 24.04.1 LTS, and Orca 1.4.144-rc.4:

1. Open a terminal in `\\wsl.localhost\Ubuntu\home\<user>\...`.
2. Emit `OSC 7;file://<machine-hostname>/home/<user>/...`.
3. Sleep for 38-69 seconds, then wake.

Both triggered attempts failed. The saved CWD became `\\<machine-hostname>\home\<user>\...`; the original WSL UNC remained valid. A 60-second control sleep without the hostname OSC 7 passed.

## Root cause and invariant

OSC 7 authority semantics follow the PTY's execution environment, not Electron's host OS. A native Windows shell may legitimately mean `\\server\share` by `file://server/share`; a WSL shell means a POSIX pathname inside its already-known distro. Orca currently classifies local WSL PTYs as generic Win32 PTYs.

The fix must establish one immutable `wslDistro: string | null` per PTY incarnation before any OSC 7 bytes or recovered history are parsed. The same value must drive daemon live parsing, incremental-history replay, runtime parsing, and legacy CWD recovery. URI authority must never select a distro.

Resolve that value with the same precedence already used to launch WSL:

1. distro in an explicit WSL UNC `cwd`;
2. distro in the worktree encoded by the daemon session ID;
3. trimmed `terminalWindowsWslDistro` selected for the spawn.

Centralize this resolution with the existing WSL session-context code so the parser and subprocess cannot disagree. Do not infer local WSL context for `connectionId`/SSH PTYs.

## Non-goals

- Do not change native Windows UNC, POSIX SSH, or remote Windows drive-path semantics.
- Do not redesign terminal history, sleep, renderer link routing, or PTY identity.
- Do not probe WSL, DNS, the filesystem, or the network on the output path.
- Do not infer a distro from an OSC hostname or mutable global/default-distro state.

## Design

### 1. Pure conversion and parser context

Move `toWindowsWslPath` to `src/shared/wsl-paths.ts` and re-export it from `src/main/wsl.ts` for existing callers. Preserve its current rules: lowercase `/mnt/<ascii-letter>` maps to a native drive; every other absolute Linux path maps under `\\wsl.localhost\<distro>`. `/MNT` and `/mnt/C` are case-sensitive Linux paths, not drvfs aliases.

Add `wslDistro?: string` to `ParseFileUriPathOptions`. When present, `parseFileUriPathParts` must:

- decode `url.pathname` exactly once;
- construct the path with `toWindowsWslPath(decodedPath, wslDistro)`, regardless of URI authority;
- continue returning the normalized URI hostname as metadata;
- reject malformed URLs/percent encoding as today and leave the prior CWD unchanged.

Without `wslDistro`, retain every existing `pathFlavor` and `remotePosixAuthority` branch.

Thread the option through `TerminalOscCwdTitleScanner` and `HeadlessEmulator`. Scanner options are constructor-scoped, so split sequences retain the same context without global state.

### 2. Daemon and history ownership

`TerminalHost` resolves the immutable distro before spawning. Pass it both to `createPtySubprocess` and to a new `SessionOptions.wslDistro`; `Session` passes it to its `HeadlessEmulator`. Store the resolved value on `Session` and return it on create/attach so a later window observes the live session's context instead of reinterpreting it from current settings. Make the response field additive/optional for compatibility with an older preserved daemon.

Extend `HistoryReader.detectColdRestore` with optional parser context and use it for the scratch `HeadlessEmulator` in `restoreFromIncrementalLog`. Every detect path in `DaemonPtyAdapter`--initial detection, probe/create race recovery, and failed history seeding--must pass the same resolved distro. This is required; fixing only the live `Session` leaves incremental restore able to reproduce the bug.

### 3. Narrow legacy checkpoint recovery

Immediately after each cold-restore detection, normalize `restoreInfo.cwd` before it becomes `effectiveCwd` or `coldRestore.cwd`. Recovery runs only on native Windows with a resolved local WSL distro:

1. Preserve an absolute drive path.
2. Preserve a `\\wsl.localhost\...` or `\\wsl$\...` path only when its distro matches the resolved distro case-insensitively.
3. Convert an absolute POSIX path through the resolved distro.
4. Repair the known legacy shape only when the UNC server equals `os.hostname()` case-insensitively: strip the server, interpret the share and tail as the Linux absolute path, then convert it. Thus `\\HOST\mnt\c\x` becomes `C:\x`.
5. For a mismatched-distro WSL UNC, another UNC server, a relative path, or malformed input, discard the recovered CWD and fall back to the current requested CWD (or the normal spawn default if none was supplied). Do not guess.

Apply the corrected/fallback value to both subprocess creation and the returned cold-restore payload. This keeps runtime seeding, the sticky restore cache, `initialCwds`, and the next checkpoint consistent. The repair is idempotent and never mutates history files in place.

### 4. Runtime ownership and races

Add `wslDistro: string | null` to `RuntimePtyWorktreeRecord`; a boolean `isWsl` is insufficient for multi-distro parsing. Pass the resolved distro from the spawn result into runtime registration. For reconstructed local records, a WSL UNC worktree may supply a fallback distro via `parseWslUncPath`; never do this for SSH records.

Daemon PTYs can emit output before `provider.spawn` resolves, and cold-restore seeding currently runs before `registerPty`. Register the expected daemon session's execution context before spawn, then replace it with the daemon-returned immutable value before snapshot/cold-restore seeding. If late discovery changes a context after a runtime emulator was created, discard that emulator and re-seed it from the authoritative provider snapshot; never keep a buffer whose CWD was parsed under mixed contexts.

Clear execution context with the other per-PTY parser maps on exit, pruning, failed spawn, and provider-generation reset. Reusing a PTY ID must not inherit a prior distro.

## Data flow

```text
spawn cwd/session/preference
  -> resolve one immutable local WSL distro
  -> daemon Session scanner + HistoryReader replay scanner
  -> decoded OSC 7 pathname (authority retained only as metadata)
  -> toWindowsWslPath(pathname, distro)
  -> daemon checkpoint + runtime live/headless CWD
  -> sleep/wake with a valid WSL UNC or drive CWD
```

Legacy recovery is a boundary repair:

```text
WSL cold restore + old checkpoint CWD
  -> exact allowlist normalization
  -> corrected spawn and coldRestore payload
  -> next checkpoint naturally persists the corrected live CWD
```

## Consistency and failure modes

- Context is per PTY incarnation, not global, so simultaneous Ubuntu and Debian panes cannot contaminate each other.
- The first creator owns a daemon session's immutable context. Concurrent/multi-window attaches consume the stored value; changed settings do not mutate a live session.
- A distro mismatch in externally changed history falls back to the requested worktree CWD instead of launching the wrong distro.
- Atomic checkpoint replacement remains unchanged. Concurrent restore callers may read different complete generations, but each normalizes before spawn and daemon create/attach still selects one live session.
- Missing context deliberately preserves current behavior. Tests must cover every local WSL construction path so this fallback cannot silently remain on the affected path.
- Native UNC and SSH behavior remain isolated because neither receives local WSL context.
- No filesystem/network work is added per output chunk; parsing remains bounded string work on completed OSC sequences.

## Test plan

- `osc7-file-uri.test.ts` and shared WSL-path tests: hostname/localhost/empty WSL authorities; hostname metadata; `/home`, `/`, lowercase `/mnt/c`, `/MNT`, `/mnt/C`; spaces/percent decoding; invalid encoding; native UNC; POSIX SSH; Windows SSH drive paths.
- `headless-emulator.test.ts`: WSL context propagation across ordinary and split OSC sequences; two emulators with different distros.
- `terminal-host.test.ts`/`session.test.ts`: resolved context reaches the daemon emulator; attach returns the session's stored context and does not adopt a conflicting later preference.
- `history-reader.test.ts`: incremental-log replay containing the exact hostname OSC 7 yields the correct WSL CWD.
- `daemon-pty-adapter.test.ts`: cover every `detectColdRestore` branch plus sticky-cache output. Repair hostname UNC and POSIX CWDs; preserve matching WSL UNC and drive paths; reject mismatched distro, other UNC, relative, native, and SSH/non-WSL cases. Assert both create/attach CWD and `coldRestore.cwd`.
- `orca-runtime.test.ts` and IPC PTY tests: context exists before early daemon output and before headless seeding; Windows-host worktree with a selected WSL distro; WSL UNC fallback after reconstruction; attach correction; PTY-ID reuse; simultaneous distros; local native and SSH isolation.
- Run focused tests, then `pnpm typecheck` and `pnpm lint`.
- Electron on native Windows: in a real Ubuntu WSL pane, emit the exact hostname OSC 7, sleep/wake twice, run `pwd` after each wake, and verify no `DaemonProtocolError`. Native UNC semantics are covered by deterministic unit tests; a screenshot of an arbitrary UNC string is not meaningful validation.

## UI quality and review evidence

There is no UI, layout, copy, or interaction change, so the Stage 5 visual-quality loop is skipped. Terminal content, CWD, and adjacent native/SSH behavior must remain unchanged.

Electron validation still requires three evidence screenshots for user review:

1. Before sleep: the WSL terminal shows the printed hostname/emission command and `pwd`.
2. After the first wake: the same pane shows the same `pwd` and no wake error.
3. After the second wake: the same pane again shows the same `pwd` and no wake error.

## Lightweight engineering review

- **Scope:** Parser context, immutable context propagation, history replay, and narrow legacy recovery. Runtime/IPC fields are necessary because parsing begins outside the daemon and may precede spawn completion.
- **Architecture/data flow:** One resolved distro drives every parser for one PTY incarnation. The URI hostname remains metadata; it never selects path namespace or distro.
- **Failure modes:** Covers missing/stale context, incremental replay, probe/create races, sticky restore, mismatched external history, split chunks, concurrent attaches, multi-window reuse, multi-distro isolation, PTY-ID reuse, and SSH/native boundaries.
- **Tests:** Requires parser tables, propagation tests at every emulator construction site, all adapter restore branches, runtime early-byte/seed races, and the deterministic Windows Electron reproduction twice.
- **Performance/blast radius:** One optional string per PTY/session and bounded conversion per OSC 7; no probes or new hot-path I/O. Non-WSL behavior is unchanged when the option is absent.
- **UI/screenshots:** No design-review loop. Three Electron screenshots are required as functional evidence; native UNC stays an automated regression test.
- **Residual risk:** Legacy checkpoints created from a non-machine hostname cannot be distinguished safely from a real UNC and therefore fall back to the requested CWD. A renamed/uninstalled distro still fails normally; this change does not guess a replacement.

## Rollout

1. Centralize distro resolution and WSL path conversion.
2. Make the parser, daemon Session, and history replay distro-aware.
3. Add allowlisted legacy recovery and keep spawn/cold-restore metadata consistent.
4. Make runtime context available before output/seeding and reset it per incarnation.
5. Add regressions, run static checks, then validate two Windows sleep/wake cycles with review screenshots.

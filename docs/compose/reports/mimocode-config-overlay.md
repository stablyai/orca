---
feature: mimocode-config-overlay
status: delivered
specs: []
plans:
  - /Users/a111/docs/compose/plans/2026-07-16-orca-mimocode-config-overlay.md
branch: fix/mimocode-config-overlay
commits: 7723ad8ee^..0124d27b0
---

# MiMoCode Config Overlay - Final Report

## What Was Built

Orca now injects its MiMoCode status plugin through `MIMOCODE_CONFIG_DIR` instead of replacing `MIMOCODE_HOME`. The generated overlay contains user configuration plus Orca's `orca-mimocode-status.js` plugin, while authentication, sessions, memory, cache, and runtime state remain owned by MiMoCode's canonical directories.

The PTY environment contract is consistent across native local and daemon launch paths, including POSIX and PowerShell shells. Nested Orca sessions retain the original user config, and GUI launches can discover config exported only by shell startup files. SSH and WSL deliberately do not install this overlay in this delivery; their boundaries strip host-local metadata so native paths cannot leak into another host.

## Architecture

`MimoCodeHookService.buildPtyEnv()` creates a PTY-isolated config overlay under Orca user data at `mimocode-config-overlays/<pty-id-hash>`. It mirrors the source config while excluding authentication, data, cache, state, sessions, memory, storage, SQLite databases, transaction sidecars, and any existing Orca status plugin, then writes a fresh plugin that reports to `/hook/mimo-code`.

Overlay construction is fail-safe. Source and target identity checks reject equal, nested, and aliased directories; writable overlay directories must be real directories rather than symlinks or junctions; and best-effort cleanup must leave an empty target before reconstruction. Ownership records bind each PTY to the real overlay root identity, make repeated builds idempotent, and prevent teardown from deleting a directory after an ancestor has been replaced. Any unsafe or failed build falls back to the original config directory, or returns no override when no original config exists.

`buildPtyHostEnv()` resolves the source in this order: recorded base source, recorded process source, base `MIMOCODE_CONFIG_DIR`, process `MIMOCODE_CONFIG_DIR`, then shell startup discovery. A returned path is marked as Orca-managed only when it differs from the source. Shell-ready wrappers restore the managed config after user startup files run.

SSH removes host-only MiMo overlay/source markers and preserves only a primary that is independent of those markers. WSL skips host overlay construction; daemon-backed WSL also removes inherited host values while preserving a request-scoped guest config. Remote and WSL guest overlay installation remain out of scope.

### Design Decisions

We chose a config-only overlay because MiMoCode 0.1.6 loads plugins from `MIMOCODE_CONFIG_DIR` without redirecting canonical data, state, provider credentials, or sessions.

We reject dirty, linked, nested, or identity-changed writable targets because mirroring a symlinked plugin directory or continuing after partial cleanup can write through to user-owned files.

We preserve `MIMOCODE_HOME` untouched because it is a user/runtime ownership boundary, not an Orca plugin injection interface.

## Usage

Orca applies the overlay automatically when a native local PTY launches `mimo` and agent status hooks are enabled. No user migration is required. Existing `MIMOCODE_CONFIG_DIR` configuration is mirrored into the overlay, and existing `MIMOCODE_HOME` values remain unchanged. SSH and WSL sessions continue without an Orca MiMo config overlay.

The standalone contract probe can be rerun with:

```bash
node config/scripts/probe-mimocode-config-dir.mjs
```

The probe creates a temporary plugin overlay, performs provider and model requests, compares canonical paths and provider state, reports only non-secret status, and removes its temporary directory.

## Verification

- `pnpm typecheck`: passed.
- `pnpm lint`: passed with 0 errors and 26 pre-existing warnings outside this change.
- Targeted Vitest suite: 8 files, 613 tests passed.
- Real MiMoCode 0.1.6 probe: plugin loaded; provider status unchanged; canonical data, config, state, and credential paths unchanged; model request passed; no runtime state appeared in the overlay.
- A poisoned parent environment containing `MIMOCODE_HOME`, `MIMOCODE_CONFIG_DIR`, and the marker variable did not affect the probe baseline.
- The legacy `MIMOCODE_HOME` command returned `OK` on the installed MiMoCode 0.1.6, so the previously reported 401 was not reproduced in this environment. The ownership and overlay isolation regression remains directly verified.

## Journey Log

> Brief notes on what informed the final design. Not required reading.

- [lesson] `mimo debug paths` and `mimo providers list` do not load plugins; a real `mimo run` lifecycle is required to prove plugin discovery.
- [pivot] Config overlay safety was strengthened after tests reproduced source deletion and plugin-directory symlink write-through risks.
- [lesson] Best-effort cleanup is not a sufficient postcondition; writable overlays must be verified empty before reconstruction.
- [pivot] Nested and GUI flows adopted the same source/overlay distinction used by Orca's OpenCode integration; SSH and WSL were explicitly bounded out rather than reusing host paths remotely.
- [lesson] The historical 401 is version- or environment-dependent; reports must separate symptom reproduction from the independently verified ownership defect.

## Source Materials

| File | Role | Notes |
|------|------|-------|
| `/Users/a111/docs/compose/plans/2026-07-16-orca-mimocode-config-overlay.md` | Implementation plan | Executed with documented runtime-version variance |
| `config/scripts/probe-mimocode-config-dir.mjs` | Contract probe | Verifies plugin loading and canonical data continuity |
| `src/main/mimo/hook-service.ts` | Config overlay service | Owns only the Orca config overlay |
| `src/main/ipc/pty.ts` | PTY environment integration | Resolves, marks, restores, and strips config overlays |

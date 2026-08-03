# PR #11369 bounded correction report

## Decision

Correction commit `38e3b29fa1c0adaa1fcdc04c73f636e6db77b3ce` is ready for two fresh child verifiers. Keep the PR blocked until independent reproduction and architecture verifiers both accept the committed candidate.

## Revisions

- Exact base: `e08eba674c195596228834bf3c1ef4f94e6b118e`
- Published PR head: `1bcfe3bcb0bfac040935f7afbb1f06ba3e43df9f`
- Rejected previous candidate: `f92db196a1d4c6cdefeb1d938b2f54b3a6a85e3e`
- Correction implementation: `38e3b29fa1c0adaa1fcdc04c73f636e6db77b3ce`
- Revert oracle: `b3627461ab81dd36cb31647ecee6a113fdc0fd4c`

## Correction

- Re-resolves the destination route after save quiescence and exactly revalidates workspace ID, root-derived relative path, execution host, runtime owner, and runtime/SSH connection and pairing generations.
- Fails closed when a sibling disappears, a folder root changes, or direct-SSH authority reconnects while the old save queue drains.
- Commits active editor reparenting through `setActiveWorktree`'s authoritative projection, so target terminal, browser, pending-creation, explorer, first-activation generation, unread, and hosted-review effects remain centralized.
- Preserves the existing atomic editor ID, draft, preview, group, watch, provenance, persistence, and collision behavior.

## Byte-identical oracle

Topology: one local renderer Zustand store with source and sibling workspace catalogs, a controlled save promise as the quiescence barrier, mocked file writes, direct-SSH generation transitions, and store subscriptions for atomic projection. This is deterministic renderer/store evidence; it is not a headed Electron, paired-server, or real SSH transport run.

Oracle files:

- `restored-editor-owner-save-lifecycle.test.ts`: SHA-256 `f6c13c1c964e15e758c70d1402f1c01742e3052995e407bb50667877de238a86`
- `restored-editor-owner-reparent.test.ts`: SHA-256 `a5e97014c38664987c69867733dca64b73a74d6c68f6375ce4633e0a34188951`

Results:

| Revision | Result |
| --- | --- |
| Base `e08eba674c` | red: migration action absent; 10 structural failures |
| Published `1bcfe3bcb0` | red: migration action absent; 10 structural failures |
| Previous candidate `f92db196a1` | red: 4 focused failures, 10 passes; stale routes return success and active state retains the source projection |
| Correction `38e3b29fa1` | green: 2 files, 14 tests |
| Revert `b3627461ab` | red: migration action absent; 10 structural failures |

The archive snapshots used the current dependency tree and were moved to Trash after the run.

## Validation

- Reliability gate: 3 files, 19 tests passed.
- Focused root ownership matrix: 9 files, 200 tests passed.
- Central activation matrix: 7 files, 467 tests passed.
- Focused mobile matrix: 2 files, 13 tests passed.
- Root and mobile TypeScript typechecks passed.
- Full root lint passed, including native/type-aware audits, the 63-gate reliability manifest, max-lines ratchet, bundled skill guides, and localization checks.
- Commit-hook oxlint, React Doctor, formatting, and diff checks passed.
- Security: stale route/host-generation tests fail closed before owner mutation; existing containment, safe-relative-path, host-isolation, and runtime-file client tests passed in the 200-test root matrix.
- Performance: the 19-test gate completed in 1.55 seconds; revalidation performs one in-memory renderer catalog lookup and generation comparison after the required save barrier, with no provider/Git scan, polling, retry, subprocess, or added watch fanout.

## Gaps

No headed Electron, live paired/headless server, real SSH reconnect, physical Windows, WSL, or Git-version journey was run for this correction. The inherited post-establish Electron IPC, cold many-repo main-process lookup, and registered-workspace symlink-policy gaps remain unchanged.

## Next action

The coordinator should launch two fresh child verifiers against the final report commit: one deterministic reproduction verifier for stale-route/generation races and one architecture verifier for centralized active-workspace projection and side effects.

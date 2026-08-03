# PR #11369 third correction report

## Verdict

The third correction is ready for independent final verification. Destination collisions now reject before activation preparation or tab-model reconciliation, while accepted migrations still combine editor ownership, reconciled target tabs/groups, active-workspace projection, and first-activation preparation in one Zustand commit.

## Immutable topology

- Base: `e08eba674c195596228834bf3c1ef4f94e6b118e`
- Published PR head: `1bcfe3bcb0bfac040935f7afbb1f06ba3e43df9f`
- Previous correction: `f92db196a1d4c6cdefeb1d938b2f54b3a6a85e3e`
- Rejected final2 candidate: `7890271160aafb760593023dd9afaf93d567d153`
- Direct revert oracle: `b3627461ab81dd36cb31647ecee6a113fdc0fd4c`
- Third-correction implementation: `b72a838cdc682c1c918fdf117792c4b0dcc420de`
- Final candidate: the finalizer-returned branch head containing this report and the typechecked implementation chain.

## Correction

`setActiveWorktree` now asks an optional state transition to accept or reject before input-quiet scheduling, webview focus preparation, tab reconciliation, activation, hosted-review refresh, unread persistence, or terminal preparation. Rejected transitions apply only their explicit cleanup patch and return `false`.

Tab reconciliation is now a pure projection that ordinary callers can still commit directly. Accepted owner migrations project reconciliation from the already-migrated editor state and merge it into the authoritative activation update, preserving valid legacy terminals, owner-derived editor state, target browser/terminal/explorer state, folder workspace authority, runtime/SSH provenance, watches, saves, drafts, and persistence without an intermediate target snapshot.

## Permanent adversarial oracle

The destination is seeded with a valid colliding editor plus a stale active tab/group entry. Migration must return `{ ok: false, reason: 'collision' }` while the destination tab, group, layout, active-group, active-workspace, and active-file projections remain reference-identical.

- File: `src/renderer/src/store/slices/restored-editor-owner-reparent.test.ts`
- Git blob: `ac62a89c671a0c8f081ebf06736715bd2150ce9f`
- SHA-256: `a61970ace80be1cb56f781aee6f878a8446c6c4527f9eb0cd0c151d8df96bf50`

The same test blob was copied into isolated `git archive` snapshots using the current dependency tree:

| Revision                     | Result                                                           |
| ---------------------------- | ---------------------------------------------------------------- |
| Base `e08eba674c`            | red: migration action absent                                     |
| Published `1bcfe3bcb0`       | red: migration action absent                                     |
| Rejected final2 `7890271160` | red: pre-commit reconciliation removes the stale destination tab |
| Implementation `b72a838cdc`  | green: collision leaves destination projection byte-identical    |
| Direct revert `b3627461ab`   | red: migration action absent                                     |

Snapshots were created directly in Trash and retained no live process, socket, watcher, credential, workspace registration, or repository mutation.

## Verification

- Final2 reproduction evidence: rejected candidate `7890271160` passed the byte-identical post-quiescence lifecycle scope 21/21; previous `f92db196a1` failed 7 tests, while base, published, and revert were structurally red.
- Permanent reliability gate: 3 files, 20 tests passed in 2.35 seconds.
- Focused ownership matrix: 9 files, 201 tests passed.
- Central activation matrix: 7 files, 548 tests passed.
- Mobile owner-routing matrix: 2 files, 13 tests passed.
- Root and mobile TypeScript typechecks passed.
- Full `pnpm lint` passed, including native and type-aware audits, reliability manifest, max-lines ratchet, bundled skills, and localization checks.
- Changed-file formatting and `git diff --check` passed.
- Zustand fanout gate passed: 2,500 subscribers across 2,000 unrelated writes, median 33.66 ms total, 0.0168 ms/write, and zero render invalidations.

## Audit and remaining gaps

The correction changes only renderer store ordering and tab-model projection. It adds no filesystem, Git, provider, RPC, capability, dependency, polling, retry, subprocess, or broad watcher path; exact execution-host, runtime, SSH connection-generation, folder workspace, containment, save, draft, persistence, and watch authority remain in the accepted transition.

No headed Electron, live paired/headless server, real SSH reconnect, physical Windows, WSL, or Git-version journey was run for this correction. The inherited post-establish Electron IPC gap, cold many-repo main-process discovery cost, and registered-workspace symlink-policy decision remain open and are not regressions introduced here.

## Next action

The coordinator should send this exact final candidate to one independent architecture verifier and keep the PR unpushed until it confirms both the permanent collision oracle and the accepted 21-test lifecycle scope.

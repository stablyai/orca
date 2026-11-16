# Independent native-chat setup provisioning review

## Design verdict

Accepted before implementation and after final diff/test review: no unresolved P0/P1 findings. All P2 concerns have explicit dispositions below.

The reviewed design is `docs/native-chat-setup-provisioning-design.md`. Review is confined to this worktree; this report is the reviewer's only edited file.

## Root cause and simplest mechanism

The structured route in `worktree-creation-flow-execute.ts` deliberately omits terminal startup and startup draft, but supplies the selected agent. `worktree-create-payload.ts`, the RPC schema, and `worktree-create-args.ts` preserve that attribution. No startup means no activation request from this payload builder.

`runtime-local-worktree-terminal-startup.ts` already suppresses a fallback shell for a background create with either `promisedAgentChat` or `createdWithAgent`. Its setup/default provisioning branch supplies only `promisedAgentChat` to `callerProvidesSurface`. The extra shell is therefore a disagreement between two branches of the same host policy.

Use the existing background policy consistently. Keep explicit `promisedAgentChat` unconditional, and count submitted agent attribution only when neither `activate` nor `runHooks` is true. A new RPC flag is unnecessary: it duplicates existing intent and would leave older clients' requests unfixed. Do not infer this from persisted worktree metadata or introduce a surface store.

## Challenges and dispositions

| Concern                                                                                       | Severity     | Disposition                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attribution is weaker than an explicit chat promise.                                          | P2           | Accepted existing background policy, not a new universal interpretation. Activated/run-hooks attribution-only creates must retain a primary surface.                          |
| A new unconditional chat promise could strand renderer issue commands waiting for a terminal. | P1 candidate | Withdrawn for the chosen design: no-setup policy is unchanged, while successful setup/default provisioning supplies a mirrored terminal. No new wire promise is being added.  |
| Renderer-only setup tests cannot catch the execution host's extra shell.                      | P2           | Require a regression through production payload/schema/mapper and host startup/provisioner, with real creation argument evidence.                                             |
| Older clients and hosts may differ.                                                           | P2           | No wire change: new hosts apply the corrected policy to existing requests; old hosts retain the known extra shell. No capability negotiation or client-local fallback needed. |
| Setup spawn failure and renderer issue-only delivery have existing asynchronous limitations.  | P2           | Keep out of this policy correction; do not claim these are repaired. Preserve current setup receipt/return behavior and failure controls.                                     |

## Invariants checked during design review

- Execution host retains terminal provisioning and setup ownership; navigation does not choose another execution host.
- The shared first-surface predicate still requires anchors for both setup split orientations and real terminal startup.
- Configured default tabs remain explicit work; they are not discarded to make the terminal count smaller.
- Setup runner construction, quoting, environment, sequencing, completion observation, and shell selection remain untouched across macOS/Linux/Windows/WSL.
- Native IPC returns setup to the renderer; paired/runtime creation reaches the host policy under review. No direct SSH fallback is introduced.
- Folder workspace creation has a separate background no-setup policy and no corresponding setup-provisioning branch; preserve it.
- Manual splits and issue command queuing remain in their existing paths. No claim is made that a setup terminal is itself a structured agent surface.

## Final verification

Final review requested and performed on the production predicate, route regression, renderer assertions, explicit promised-chat controls, and node typecheck inclusion. No unresolved P0/P1 found. Final `git diff --check` passed.

The sole production change replaces both branch-specific decisions with `callerProvidesInitialSurface`. The original no-setup branch can execute only when activation/run-hooks are false, so adding those guards to the common predicate does not change its behavior. Setup/default provisioning is the only newly affected branch. Explicit startup still supplies `startupNeedsTerminal`; successful startup/default terminals still count as existing primary surfaces; split modes still override suppression.

The route regression invokes the production renderer payload builder, RPC schema/mapper, runtime creation, and terminal provisioner. The renderer test separately checks the actual execute call's selected agent, absent startup, and absent startup draft. This is composed route evidence, not a rendered end-to-end UI test. The runtime fixture waits for provisioning to observe terminal calls deterministically.

Reviewed the lead's pre-fix log `/tmp/orca-native-chat-before.log`: both agent cases failed on the unexpected `undefined` command preceding Setup, while nine controls passed. Reviewed `/tmp/orca-native-chat-tests.log`: seven files passed, 1,451 tests passed and one skipped. Supplemental validation is attributed below.

P2 test hardening resolved during final review: the split control now asserts that `ORCA_TAB_ID` is a nonempty string before comparing the two panes' values.

Independent baseline run: `ORCA_BACKGROUND_LAUNCH=1 pnpm test` for `runtime-local-worktree-terminal-startup.test.ts`, `runtime-worktree-terminal-provisioning.test.ts`, `runtime-folder-worktree-create.test.ts`, and `rpc/methods/worktree-create-args.test.ts` passed all 37 tests in four files. These existing tests establish controls; they do not demonstrate the new regression fix.

The added node typecheck include names only the pure, type-only-importing renderer payload builder used by the regression; it follows existing cross-layer fixture includes and introduces no runtime renderer dependency.

Lead-reported supplemental validation: 15 focused promised-chat/route controls and four `worktree-agent-first-surface` controls passed; node/web typechecks exited zero and changed-file lint passed. The reviewed final source contains the corrected predicate and the strengthened split assertion.

The coordinator explicitly closed the independent code review after these checks. Any hidden-renderer before/after proof is lead-owned and is not an independently verified claim in this report. The reviewer launched no application or visible window. No live SSH, Windows, or WSL validation is claimed; compatibility conclusions concern the unchanged routing, wire contract, and runner code.

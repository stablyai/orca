# Native-chat background setup provisioning

## Problem and evidence

A structured native-chat creation deliberately omits terminal startup in `worktree-creation-flow-execute.ts`, while passing the selected agent as `createdWithAgent`. `buildRuntimeWorktreeCreateParams` and the RPC `buildManagedWorktreeCreateArgs` preserve that agent and leave activation false when startup is absent. The execution host therefore handles this as background creation, even when the renderer later opens the chat.

The host already treats a submitted agent as a caller-provided surface for background creation without setup. With setup/default tabs, `provisionArgs` instead recognizes only the internal `promisedAgentChat` flag. In new-tab setup mode this inconsistency creates an idle shell before Setup. Renderer-only tests returning unprovisioned setup do not exercise that host decision.

## Proposed policy

Use one host-local caller-surface predicate for terminal provisioning and fallback shell seeding: explicit `promisedAgentChat` always counts; submitted `createdWithAgent` counts only when neither `activate` nor `runHooks` is true. These are transient inputs to this create, not persisted workspace metadata. Apply the same predicate whether or not setup/default tabs exist.

Continue using `shouldSeedWorktreePrimaryTerminal`: a real startup, issue work, existing default terminal, setup-only choice, and split setup anchors retain their existing precedence. Activated attribution-only requests still owe a primary terminal; attribution must not become an activation promise. Preserve every setup split mode and current setup sequencing, surfacing, completion, and failure behavior.

## Scope and compatibility

Change only the host startup policy and regression coverage. No new RPC field, surface store, ownership/retry redesign, split removal, process command change, or UI styling. Renderer and RPC already transmit enough information for the existing background policy; a new wire intent would duplicate that policy and leave older clients unfixed. Old clients benefit when connected to the updated execution host; updated clients connected to old hosts retain the old behavior. Nothing changes execution-host ownership or introduces client-local SSH fallback.

Folder creation has its own matching no-setup background policy and no automated setup provisioning path; retain it and cover its existing contract. The shared host policy is platform independent and leaves macOS/Linux/Windows/WSL runner construction unchanged. Manual splits, explicit commands, issue automation, default tabs, and startup failures remain owned by their existing mechanisms.

Background attribution-only callers intentionally inherit their established no-setup policy. The pre-existing conditional issue-only/first-terminal coupling and asynchronous setup failure reporting are P2 follow-ups outside this change; successful setup/default provisioning still supplies the terminal used for queued issue work. Independent Astra design review accepted this scope with no P0/P1 before implementation.

## Verification

Add coverage that feeds actual structured renderer creation arguments through the production payload builder, RPC schema/argument mapping, host startup, and real terminal provisioner, recording created terminals. New-tab setup should create Setup alone for background native chat, while blank/background creation still receives its shell. Cover both agents, activated attribution-only creation, run-hooks, promised chat, explicit startup, default tabs, split anchors, and setup-only/failure behavior using existing tests where adequate.

Demonstrate the regression failing against the original policy and passing after the change. Run relevant renderer/runtime/RPC/provisioning/folder tests, node and web typechecks, and changed-file format/lint checks with `ORCA_BACKGROUND_LAUNCH=1`. No platform or rendered UI result is claimed without an actual run. Independent Astra review must converge before implementation and review the final diff with no unresolved P0/P1; record P2 dispositions in the review report.

## Results

The original policy failed both agent regressions by spawning an undefined-command shell before Setup; nine controls passed. With the fix, seven selected suites passed 1,451 tests with one existing skip; 15 focused route/promised-chat controls and four first-surface tests also passed. Node/web typechecks, changed-file lint, formatting, and the Electron e2e build passed on macOS ARM64.

A temporary Playwright probe used isolated hidden host/client apps, the production renderer create action with `createdWithAgent: codex` and no startup, real RPC/PTY provisioning, host terminal inventory, and DOM tab-strip assertions. The baseline host rendered two terminal tabs; the fixed host rendered Setup alone. Both runs passed hidden/unfocused-window assertions and captured CDP screenshots. This verifies the terminal provisioning behavior, without claiming a real structured-agent launch or live SSH/Windows/Linux/WSL run. Probe source, logs, and screenshots are retained locally under `.bench-fixtures/native-chat-setup-proof/`; screenshots are attached to the PR, not committed. Final source was restored and rebuilt after the baseline capture.

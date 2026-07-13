# Headless Serve to Desktop Activation Implementation Plan

**Goal:** Safely activate a desktop window from the existing headless serve owner without restarting
the runtime, daemon, PTY sessions, or agents.

**Architecture:** Make serve adopt the persistent daemon before becoming ready, gate desktop
activation on that provider contract, transfer runtime graph authority from a named headless
sentinel to the first real window, and make local `orca open` verify desktop availability instead of
RPC reachability.

## Task 1: Lock the lifecycle contract with failing tests

**Files:**

- Add `src/main/startup/serve-desktop-activation.test.ts`
- Modify `src/main/runtime/orca-runtime.test.ts`
- Modify `src/cli/runtime-client.test.ts`
- Add `src/main/startup/serve-desktop-activation-wiring.test.ts`

**Steps:**

1. Test deferred activation coalescing, ready drain, and fail-closed behavior.
2. Test graph authority transfer from headless sentinel to a real BrowserWindow.
3. Test desktop status reporting and local/remote CLI open decisions.
4. Add a source-level wiring regression for serve startup order and removal of unsafe direct open.
5. Run the focused tests and record the expected RED failures.

## Task 2: Implement activation state and status contracts

**Files:**

- Add `src/main/startup/serve-desktop-activation.ts`
- Modify `src/shared/runtime-types.ts`
- Modify `src/main/runtime/orca-runtime.ts`
- Modify `src/main/index.ts`

**Steps:**

1. Add the activation state machine and named headless window sentinel.
2. Report `available`, `openable`, `initializing`, or `blocked` from runtime status.
3. Transfer authority through renderer-reloading before the promoted renderer publishes.
4. Route second-instance and app activation through the gate.

## Task 3: Make serve and desktop share the persistent provider contract

**Files:**

- Modify `src/main/index.ts`
- Update focused startup/runtime tests as required

**Steps:**

1. Start the daemon and hook barrier in both modes.
2. Await the local-PTY barrier before headless IPC registration.
3. Mark serve activation ready only for a persistent provider; otherwise mark blocked.
4. Install terminal side-effect delivery in both modes while keeping desktop-only scanners disabled
   until a real renderer graph is ready.
5. Confirm no promotion path invokes daemon initialization a second time.

## Task 4: Fix `orca open`

**Files:**

- Modify `src/cli/runtime/client.ts`
- Modify `src/cli/runtime/status.ts`
- Modify `src/cli/format.ts`
- Modify `src/main/ssh/ssh-remote-orca-cli.ts`
- Modify `src/main/ssh/ssh-remote-cli-format.ts`
- Update relevant tests

**Steps:**

1. Thread desktop status through local and remote CLI status shapes.
2. Mock the existing launch boundary for deterministic tests.
3. Always activate the local application and wait for `available`.
4. Return a specific error for `blocked` and a safe timeout for old/unknown runtimes.
5. Preserve remote-pairing behavior without launching a local app.

## Task 5: Add isolated Electron lifecycle smoke

**Files:**

- Add `tests/e2e/headless-serve-desktop-activation.spec.ts`
- Modify `config/reliability-gates.jsonc`

**Steps:**

1. Launch serve and a disposable RPC-created terminal in an isolated profile.
2. Activate the same app normally and observe the window on the original owner.
3. Assert runtime and PTY identity continuity plus post-promotion input/output.
4. Record exact macOS evidence and cross-platform gaps in the reliability gate.

## Task 6: Verify and submit

**Checks:**

1. Focused RED/GREEN tests.
2. Focused isolated Electron smoke twice.
3. `pnpm run typecheck`.
4. `pnpm run lint`.
5. `pnpm run build:desktop`.
6. `git diff --check` and final diff review.
7. Push an independent fork branch, open an upstream PR linked to #8457, and wait for green CI.

**Failure handling:** Any evidence of daemon restart, PTY id replacement, new agent launch, second
profile owner, or renderer promotion while the persistent provider is unavailable blocks the PR.

**Known verification limits:** Native Windows/WSL/SSH live activation cannot be reproduced on this
macOS host; keep those as explicit reliability gaps and rely on pure cross-platform policy tests plus
CI build/type coverage.

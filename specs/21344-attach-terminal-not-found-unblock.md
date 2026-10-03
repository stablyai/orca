## Current State
Implementation and tests complete. All 18 test files (147 unit tests) pass. Diff reviewed and approved across all three validation agents: `riley-pr-agent` (APPROVED), `riley-pr-check` (PASS), and `riley-the-maintainer` (APPROVED).

## Summary
When `attach()` encounters `terminal_not_found` or `tab_not_found` (or `resolvePersistedHostPane()` returns null), it cleanly tears down the attachment:
1. Resets lifecycle flags: `connecting = false`, `connected = false`, `terminalEnded = true`.
2. Clears `handle = null` to prevent spurious duplicate `onDisconnect` events during subsequent `destroy()`.
3. Clears pending viewport claims, closes multiplexed stream, and marks attachment unavailable.
4. Emits `onPtyExit(toRemoteRuntimePtyId(persistedHandle, currentRuntimeEnvironmentId), -1)`.
5. Updates `isRemoteTerminalGoneMessage` and `resolvePersistedHostPane` to recognize both `terminal_not_found` and `tab_not_found`.

## Files to Touch
- `src/renderer/src/components/terminal-pane/remote-runtime-pty-transport.ts`
- `src/renderer/src/components/terminal-pane/remote-runtime-pty-transport-expired-pane-recovery.test.ts`
- `specs/21344-attach-terminal-not-found-unblock.md`

## Step-by-Step
1. Write red acceptance tests asserting `onPtyExit` emission with exitCode -1, `tab_not_found` error handling, and `destroy()` non-duplication.
2. Verify RED state via Vitest runner.
3. Implement `tab_not_found` in `isRemoteTerminalGoneMessage` & `resolvePersistedHostPane`, and full teardown + `onPtyExit` + `handle = null` in `attach()`.
4. Verify GREEN state via Vitest runner.
5. Review loop:
   - `riley-pr-agent`: Caught missing `handle = null`; resolved and re-reviewed -> APPROVED.
   - `riley-pr-check`: Ran code-quality-changed, oxlint, and Vitest suite -> PASS.
   - `riley-the-maintainer`: Verified claims, wire boundaries, and invariant compliance -> APPROVED.

## Verification
- `HUSKY=0 pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/components/terminal-pane/remote-runtime-pty-transport-expired-pane-recovery.test.ts` (7 passed)
- `HUSKY=0 pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/components/terminal-pane/remote-runtime-pty-transport*.test.ts` (18 suites, 147 passed)
- `HUSKY=0 pnpm run check:code-quality:changed` (0 findings)
- `HUSKY=0 pnpm exec oxlint src/renderer/src/components/terminal-pane/remote-runtime-pty-transport*` (0 findings)

## Notes for Next Agent
Ready for merge into main.

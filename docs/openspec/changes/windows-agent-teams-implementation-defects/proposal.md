## Why

Enabling Claude Agent Teams native panes on Windows was scoped as three `process.platform === 'win32'` guards plus a compiled `tmux.exe` shim. Removing those guards was correct but not sufficient: the surrounding code had never been exercised on Windows, and six further defects were found during implementation. Four of them would each independently have left the feature non-functional, and two surfaced only when a user ran the build and reported what they saw.

The symptoms a user actually hit, in order:

1. Settings listed Claude Agent Teams as "Available to install" no matter what — a fourth, undiscovered platform gate in agent detection.
2. Launching it failed with `spawn claude ENOENT` — PATH was read under the wrong key casing, leaving the teammate with a one-directory PATH.
3. Claude then launched but rendered nothing at all — the Orca CLI runs inside Electron-as-node, whose stdin is not a TTY, so the Claude TUI never became interactive.

Alongside those, the shipped shim could never reach the dispatcher (argv shifted by one), fabricated its own version string to satisfy a test, and its integration tests compiled the wrong binary and were red on Windows.

## What Changes

- Fix the compiled shim so forwarded argv reaches the CLI, and stop it fabricating a `tmux -V` response.
- Read and write `PATH` case-insensitively, under the caller's own key, so Windows callers keep their inherited PATH.
- Detect Claude Agent Teams on Windows (keep WSL unsupported).
- Launch Claude directly on Windows instead of through the Orca CLI wrapper, so the TUI gets a real TTY.
- Map the tmux key names `send-keys` previously passed through as literal text.
- Accept prefix-only Node builtins (`node:sqlite`) in the packaged-runtime verifier, which blocked packaging entirely.
- Replace vacuous and mis-targeted tests with ones that assert the behavior they claim to.

No change to the tmux dispatcher, the RPC surface, or any non-Windows launch path.

## Capabilities

### New Capabilities

- `claude-agent-teams-native-panes`: teammate panes for Claude Agent Teams — platform support, how the tmux-compatible shim is resolved, invoked and kept argv-faithful, how the launch environment is composed, and when the feature degrades instead of failing.

### Modified Capabilities

<!-- None. docs/openspec/specs/ is empty; this records the capability's full required behavior. -->

## Impact

**Code**

- `native/windows-cli-launcher/OrcaTmuxShim.cs` — argv forwarding, batch-target support, no fabricated sentinel
- `src/shared/env-var-casing.ts` *(new)* — case-insensitive env read plus key resolution
- `src/main/runtime/claude-agent-teams-service.ts` — PATH composed case-insensitively
- `src/main/runtime/claude-agent-teams-shim-env.ts` — shim-bin lookup, dev fallback, idempotent copy
- `src/shared/tui-agent-config.ts` — Windows detection and launch command
- `src/shared/claude-agent-teams-tmux-compat.ts` — `send-keys` key mapping
- `config/packaged-runtime-node-modules.cjs` — prefix-only builtin handling
- `config/scripts/build-windows-cli-launcher.mjs` — `--source` for test stubs

**Upstream**

`config/packaged-runtime-node-modules.cjs` is byte-identical on `origin/main`, so the `node:sqlite` defect exists upstream and is worth submitting independently of the Windows work. No Node version fixes it — `builtinModules` omits prefix-only builtins on 22 and 24 alike.

**Behavioral**

Launching Claude directly on Windows means `agent-process-recognition.ts` sees the process as plain "Claude" rather than "Claude Agent Teams". Believed cosmetic — functional paths key on the `--teammate-mode auto` flag — but not verified.

**Not addressed**

The same PATH-casing pattern exists in `terminal-attribution.ts` and `pty.ts:971/979`. Out of scope here; the attribution one affects every Orca terminal on Windows, not just agent teams.

**Still unproven**

A teammate pane rendering a working, interactive TUI has never been observed. The trigger itself is not the obstacle: Claude invokes the shim and panes are created — the PowerShell failures recorded as defects 13, 14 and 15 were Claude's own teammate commands running inside those panes. What is unproven is the outcome after those fixes, which the daemon-staleness defect prevented from ever deploying.

import process from 'node:process'
import { pathToFileURL } from 'node:url'

export const LINUX_PACKAGE_TESTS = [
  'config/scripts/packaged-repository-input-exclusion.test.mjs',
  'src/main/browser/popup-origin-chrome.electron.test.ts',
  'src/main/browser/browser-link-materialization.electron.test.ts',
  'src/main/browser/browser-client-page-renderer-lifecycle.electron.test.ts',
  'src/main/browser/browser-route-tcp-egress.electron.test.ts',
  'src/main/browser/browser-route-webrtc-egress.electron.test.ts',
  'src/main/browser/browser-route-h3-egress.electron.test.ts',
  'src/main/browser/browser-route-dns-prefetch.electron.test.ts',
  'src/main/persistence/profile-state/profile-state-writer-stall.electron.test.ts',
  'src/main/browser/browser-popup-compatibility.electron.test.ts',
  'src/main/browser/browser-popup-adapter-compatibility.electron.test.ts',
  'src/main/browser/browser-popup-native-compatibility.electron.test.ts',
  'src/main/browser/browser-popup-background-compatibility.electron.test.ts'
]

// Why: cloud/ is neither linted nor format-checked, so without this a cloud-only diff skips the
// static job's check-test-file-runners.mjs; any code file may register tests, so all of them route.
const CLOUD_TEST_RUNNER_INPUT = /^cloud\/(?:.+\.[cm]?[jt]sx?|(?:.+\/)?package\.json)$/

export function isCloudTestRunnerInput(file) {
  return CLOUD_TEST_RUNNER_INPUT.test(file)
}

// The package (windows) job's "Test Windows-specific boundaries" step runs exactly these files.
export const WINDOWS_BOUNDARY_TESTS = [
  'src/main/zcode/zcode-plan-api-key-store-native-windows.test.ts',
  'config/scripts/rebuild-native-deps.test.mjs',
  'config/scripts/rebuild-native-deps-windows-process-tree.test.mjs',
  'config/scripts/rebuild-native-deps-node-pty.test.mjs',
  'config/scripts/ensure-native-runtime-job-ownership.test.mjs',
  'config/scripts/verify-packaged-node-pty-job-ownership.test.mjs',
  'config/scripts/windows-pe-machine.test.mjs',
  'config/scripts/build-windows-cli-launcher.test.mjs',
  'config/scripts/verify-packaged-windows-agent-hook.test.mjs',
  'config/scripts/script-module-dependencies.test.mjs',
  'src/main/windows-registry-addon.test.ts',
  'src/main/daemon/daemon-host-process-package.test.ts',
  'src/shared/windows-security-addon.win32.test.ts',
  'config/scripts/windows-process-tree-gyp-path.test.mjs',
  'config/scripts/windows-process-tree-gyp-rebuild.test.mjs',
  'config/scripts/package-electron-runtime-contract.test.mjs',
  'config/scripts/electron-builder-runtime-resources.test.mjs',
  'src/main/browser/browser-client-page-renderer-lifecycle.electron.test.ts',
  'src/main/browser/browser-route-tcp-egress.electron.test.ts',
  'src/main/browser/browser-route-webrtc-egress.electron.test.ts',
  'src/main/browser/browser-route-h3-egress.electron.test.ts',
  'src/main/browser/browser-route-dns-prefetch.electron.test.ts',
  'src/main/persistence/profile-state/profile-state-writer-stall.electron.test.ts',
  'src/main/providers/windows-conpty-wide-char-duplication.node-pty.test.ts',
  'src/main/providers/pty-repaint-wide-char-buffer.node-pty.test.ts',
  'src/shared/__tests__/process-host/windows-command-line.win32.test.ts',
  'src/shared/__tests__/process-host/windows-cmd-shim-resolution.test.ts',
  'src/shared/__tests__/process-host/windows-cmd-shim-resolution.win32.test.ts',
  'src/shared/__tests__/process-host/windows-tree-kill-late-taskkill.win32.test.ts',
  'src/shared/omp-fresh-launch-cmd.win32.test.ts',
  'src/main/agent-hooks/windows-hook-payload-delivery.test.ts',
  'src/main/agent-hooks/managed-hook-stdin-lifecycle.test.ts',
  'src/main/jcode/hook-gate-script.test.ts',
  'src/main/agent-hooks/windows-direct-cmd-hook-command.test.ts',
  'src/main/agent-hooks/windows-native-hook-exe-hosts.test.ts',
  'src/main/claude/windows-native-hook-registration.test.ts',
  'src/main/agent-hooks/windows-cmd-hook-command-unicode.test.ts',
  'src/main/agent-hooks/windows-batch-hook-launcher.test.ts',
  'src/main/agent-hooks/windows-powershell-hook-launcher.test.ts',
  'src/main/claude/claude-status-line-windows.test.ts',
  'src/main/codex/windows-hook-command.test.ts',
  'src/main/codex/windows-hook-upgrade.test.ts',
  'src/main/codex/hook-service-managed-install.test.ts',
  'src/main/windows/windows-pty-job.win32.test.ts',
  'src/main/windows/windows-msys-job.win32.test.ts',
  'src/main/providers/agent-foreground-process-git-bash.win32.test.ts',
  'src/main/windows/windows-host-job.win32.test.ts',
  'src/main/windows/windows-process-tree-command-line-patch.test.ts',
  'src/main/windows/windows-process-table-native-addon.win32.test.ts',
  'src/main/windows/windows-administrator-status.win32.test.ts',
  'src/main/windows/windows-administrator-restart.win32.test.ts',
  'src/main/daemon/daemon-pid-identity-native.win32.test.ts',
  'src/main/persistence/profile-state/profile-state-access-windows-native.win32.test.ts',
  'src/main/windows-live-tree-kill.win32.test.ts',
  'src/main/wsl/wsl-runner.test.ts',
  'src/main/wsl/wsl-guest-environment.test.ts',
  'src/main/wsl/wsl-executable-path.win32.test.ts',
  'src/main/claude-accounts/claude-profile-history-windows.test.ts',
  'src/main/wsl/wsl-w1-w3-contract.test.ts',
  'src/shared/source-scan/source-tree-scan.test.ts',
  'src/main/cli/wsl-cli-powershell-boundary.test.ts',
  'src/main/computer/desktop-script-runtime-host.win32.test.ts',
  'src/main/cursor/hook-service.test.ts',
  'src/main/orca-profiles/profile-index-store.test.ts',
  'src/main/startup/windows-install-dir-acl-repair.win32.test.ts',
  'src/main/startup/windows-app-data-path.test.ts',
  'src/main/runtime/repo-worktree-admin-fingerprint.test.ts',
  'src/main/runtime/worktree-scan-admin-fingerprint-gate.test.ts',
  'src/shared/secure-file-fsync-flags.test.ts',
  'src/shared/secure-path-windows-acl.win32.test.ts',
  'src/main/runtime/unreadable-secret-store-preservation.win32.test.ts',
  'src/main/ipc/pty-codex-account-attribution.test.ts',
  'src/main/ipc/pty-spawn-env-codex-resume-provenance.test.ts',
  'src/main/ipc/preflight-provider-command-selection.test.ts',
  'src/main/ipc/preflight-runnable-local-cli.test.ts',
  'src/main/managed-server/install/remote-node-runtime-store-windows.test.ts',
  'src/main/skills/skill-windows-rename-contention.integration.test.ts',
  'src/main/skills/bundled-skill-install/local-host.test.ts',
  'src/main/skills/bundled-skill-install/plan-selection.test.ts'
]

const WINDOWS_PROCESS_PROBE_PREFIXES = [
  'config/nsis/',
  'config/scripts/nsis-process-check',
  'config/scripts/idle-cpu-process-sampling',
  'config/vitest.config.',
  'config/scripts/vitest-',
  'config/scripts/ci-unit-',
  'config/scripts/workspace-source-exports',
  'config/dark-build-switches.',
  'src/packages/process-host/'
]

export function isWindowsProcessProbePath(file) {
  return WINDOWS_PROCESS_PROBE_PREFIXES.some((prefix) => file.startsWith(prefix))
}

export const WINDOWS_PACKAGE_TESTS = [
  ...WINDOWS_BOUNDARY_TESTS,
  ...LINUX_PACKAGE_TESTS,
  // The "Test Windows installer process probe" step runs these serially.
  'config/scripts/nsis-process-check.test.mjs',
  'config/scripts/idle-cpu-process-sampling.test.mjs'
]

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(WINDOWS_BOUNDARY_TESTS.join('\n'))
}

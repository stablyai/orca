import process from 'node:process'
import { pathToFileURL } from 'node:url'

const NATIVE_RUNTIME_PREFIXES = [
  'config/scripts/ensure-native-runtime',
  'config/scripts/native-build/node-addons/ensure-native-runtime',
  'config/scripts/initialize-windows-native-toolchain',
  'config/scripts/native-build/windows/initialize-windows-native-toolchain',
  'config/scripts/capture-windows-native-environment',
  'config/scripts/native-build/windows/capture-windows-native-environment',
  'config/scripts/rebuild-native-deps',
  'config/scripts/native-build/node-addons/rebuild-native-deps',
  'config/scripts/node-pty-job-ownership',
  'config/scripts/native-build/node-addons/node-pty-job-ownership',
  'config/scripts/windows-pe-machine',
  'config/scripts/native-build/windows/windows-pe-machine',
  'config/scripts/windows-pe-image-fixture',
  'config/scripts/native-build/windows/windows-pe-image-fixture',
  'config/scripts/script-module-dependencies',
  'config/scripts/test-fixtures/script-copy-closure/script-module-dependencies',
  'config/scripts/windows-process-tree-creation-time',
  'config/scripts/native-build/windows/windows-process-tree-creation-time',
  'config/scripts/windows-process-tree-gyp-rebuild',
  'config/scripts/native-build/windows/windows-process-tree-gyp-rebuild',
  'config/scripts/electron-builder-native-rebuild',
  'config/scripts/desktop-distribution/runtime-verification/electron-builder-native-rebuild',
  'config/scripts/native-build-entry',
  'config/scripts/native-build/node-addons/native-build-entry',
  'config/scripts/shared-native-build',
  'config/scripts/native-build/node-addons/shared-native-build',
  'config/patches/node-pty@',
  'config/patches/@vscode__windows-process-tree'
]

const SHARED_PACKAGE_PREFIXES = [
  'electron.vite.config.ts',
  'config/electron-builder',
  'config/packaged-runtime',
  'config/packaged-native-build-entries',
  'config/build-plugins/',
  'config/scripts/build-',
  'config/scripts/cli-build/build-',
  'config/scripts/native-build/macos/build-',
  'config/scripts/desktop-distribution/linux/build-',
  'config/scripts/desktop-distribution/macos/build-',
  'config/scripts/build/mobile-web-app/build-',
  'config/scripts/native-build/composition/build-',
  'config/scripts/orcad-distribution/prebuilds/build-',
  'config/scripts/orcad-distribution/template/build-',
  'config/scripts/orcad-distribution/server-bundle/build-',
  'config/scripts/plugin-build/declarative-runtime/build-',
  'config/scripts/terminal-dependencies/serialize-addon/build-',
  'config/scripts/build-identity/build-',
  'config/scripts/native-build/linux/build-',
  'config/scripts/native-build/windows/build-',
  'config/scripts/workspace-package-build/build-',
  'config/scripts/remote-host-build/wsl-guest/build-',
  'config/scripts/smoke-packaged',
  'config/scripts/desktop-distribution/runtime-verification/smoke-packaged',
  'config/scripts/install-electron-package-binary',
  'config/scripts/electron-installation/platform-layout/install-electron-package-binary',
  'config/scripts/verify-packaged',
  'config/scripts/desktop-distribution/runtime-verification/verify-packaged',
  'config/scripts/orcad-distribution/template/verify-packaged',
  'config/scripts/verify-skills-cli-runtime',
  'config/scripts/runtime-verification/skills-cli/verify-skills-cli-runtime',
  'config/scripts/verify-linux-glibc',
  'config/scripts/native-build/linux/verify-linux-glibc',
  'config/scripts/run-electron-vite',
  'config/scripts/development/launch/run-electron-vite',
  'config/scripts/desktop-build/execution/run-electron-vite',
  'skills/',
  'skill-guides/',
  'resources/build/',
  'resources/onboarding/',
  'resources/plugins/',
  'resources/skills/',
  ...NATIVE_RUNTIME_PREFIXES
]

export const LINUX_PACKAGE_PREFIXES = [
  ...SHARED_PACKAGE_PREFIXES,
  'config/scripts/package-linux-formats',
  'config/scripts/desktop-distribution/linux/package-linux-formats',
  'config/scripts/tool-invocation/process-failure-message.mjs',
  'config/scripts/artifact-storage/reflink-copy/space-sharing-copy.mjs',
  '.github/actions/prepare-linux-package-fixture/',
  '.github/actions/prepare-wayland-clipboard/',
  'config/docker/cli-launch-contract/',
  'config/docker/headless-pairing/',
  'config/docker/headless-serve-shutdown/',
  'config/docker/daemon-shutdown-descendants/',
  'config/scripts/run-linux-cli-launch-contract',
  'config/scripts/runtime-verification/desktop-transport/run-linux-cli-launch-contract',
  'config/scripts/run-headless-linux-pairing-docker',
  'config/scripts/runtime-verification/daemon-lifecycle/run-headless-linux-pairing-docker',
  'config/scripts/run-daemon-shutdown-descendants-docker',
  'config/scripts/runtime-verification/daemon-lifecycle/run-daemon-shutdown-descendants-docker',
  'config/scripts/static-appimage-package-contract',
  'config/scripts/desktop-distribution/appimage/static-appimage-package-contract',
  'native/computer-use-linux/',
  'native/wayland-clipboard/',
  'resources/linux/',
  'config/scripts/run-headless-serve',
  'config/scripts/runtime-verification/daemon-lifecycle/run-headless-serve'
]

export const WINDOWS_PACKAGE_PREFIXES = [
  ...SHARED_PACKAGE_PREFIXES,
  'native/windows-cli-launcher/',
  'native/windows-agent-hook/',
  'native/computer-use-windows/',
  'resources/win32/',
  'config/scripts/build-windows-cli-launcher',
  'config/scripts/native-build/windows/build-windows-cli-launcher',
  'config/scripts/build-windows-agent-hook',
  'config/scripts/native-build/windows/build-windows-agent-hook',
  'config/scripts/windows-rust-executable-build',
  'config/scripts/native-build/windows/windows-rust-executable-build',
  'config/scripts/verify-packaged-windows-agent-hook',
  'config/scripts/desktop-distribution/runtime-verification/verify-packaged-windows-agent-hook',
  'config/scripts/windows-pty-native-capability',
  'tests/tools/windows-pty-native-capability-smoke/'
]

export const LINUX_PACKAGE_TESTS = [
  'src/main/browser/cookies/browser-google-cookie-clear.electron.test.ts',
  'config/scripts/desktop-distribution/runtime-verification/packaged-repository-input-exclusion.test.mjs',
  'src/main/browser/guest-lifecycle/popups/presentation/popup-origin-chrome.electron.test.ts',
  'src/main/browser/guest-lifecycle/navigation/browser-link-materialization.electron.test.ts',
  'src/main/browser/client-pages/renderer/browser-client-page-renderer-lifecycle.electron.test.ts',
  'src/main/persistence/profile-state/profile-state-writer-stall.electron.test.ts',
  'src/main/browser/guest-lifecycle/popups/compatibility/browser-popup-compatibility.electron.test.ts',
  'src/main/browser/guest-lifecycle/popups/compatibility/browser-popup-native-compatibility.electron.test.ts',
  'src/main/browser/guest-lifecycle/popups/compatibility/browser-popup-background-compatibility.electron.test.ts',
  'src/main/browser/extensions/api-runtime/browser-extension-api.electron.test.ts',
  'src/main/browser/extensions/profile-storage/browser-extension-persistence.electron.test.ts',
  'src/main/browser/extensions/profile-sessions/browser-extension-lifecycle.electron.test.ts',
  'src/main/browser/extensions/actions/browser-extension-toolbar.electron.test.ts',
  'src/main/browser/extensions/native-messaging/browser-extension-native-messaging.electron.test.ts'
]

// Cloud-only code must run check-test-file-runners: cloud is neither linted nor format-checked, and any source can register tests.
const CLOUD_TEST_RUNNER_INPUT = /^cloud\/(?:.+\.[cm]?[jt]sx?|(?:.+\/)?package\.json)$/

export function isCloudTestRunnerInput(file) {
  return CLOUD_TEST_RUNNER_INPUT.test(file)
}

// The package (windows) job's "Test Windows-specific boundaries" step runs exactly these files.
export const WINDOWS_BOUNDARY_TESTS = [
  'config/scripts/native-build/node-addons/rebuild-native-deps.test.mjs',
  'config/scripts/native-build/node-addons/rebuild-native-deps-windows-process-tree.test.mjs',
  'config/scripts/native-build/node-addons/rebuild-native-deps-node-pty.test.mjs',
  'config/scripts/desktop-distribution/runtime-verification/verify-packaged-node-pty-job-ownership.test.mjs',
  'config/scripts/native-build/windows/windows-pe-machine.test.mjs',
  'config/scripts/native-build/windows/build-windows-cli-launcher.test.mjs',
  'config/scripts/desktop-distribution/runtime-verification/verify-packaged-windows-agent-hook.test.mjs',
  'src/main/windows/windows-registry-addon.test.ts',
  'src/main/daemon/executable-host/windows/testing/daemon-host-process-package.test.ts',
  'src/shared/windows-security-addon.win32.test.ts',
  'config/scripts/desktop-distribution/runtime-verification/package-electron-runtime-contract.test.mjs',
  'config/scripts/desktop-distribution/runtime-verification/electron-builder-runtime-resources.test.mjs',
  'src/main/browser/client-pages/renderer/browser-client-page-renderer-lifecycle.electron.test.ts',
  'src/main/persistence/profile-state/profile-state-writer-stall.electron.test.ts',
  'src/main/providers/windows-conpty-wide-char-duplication.node-pty.test.ts',
  'src/shared/__tests__/process-host/windows-command-line.win32.test.ts',
  'src/shared/__tests__/process-host/windows-cmd-shim-resolution.test.ts',
  'src/shared/__tests__/process-host/windows-cmd-shim-resolution.win32.test.ts',
  'src/shared/__tests__/process-host/windows-tree-kill-late-taskkill.win32.test.ts',
  'src/shared/agent-launch/startup/omp-fresh-launch-cmd.win32.test.ts',
  'src/shared/windows-batch-spawn.win32.test.ts',
  'src/main/claude/structured/launch/claude-structured-child-env.test.ts',
  'src/main/agent-hooks/installation/commands/windows-hook-payload-delivery.test.ts',
  'src/main/agent-hooks/installation/scripts/managed-hook-stdin-lifecycle.test.ts',
  'src/main/jcode/hook-gate-script.test.ts',
  'src/main/agent-hooks/installation/commands/windows-native-hook-exe-hosts.test.ts',
  'src/main/claude/windows-native-hook-registration.test.ts',
  'src/main/agent-hooks/installation/commands/windows-batch-hook-launcher.test.ts',
  'src/main/claude/claude-status-line-windows.test.ts',
  'src/main/codex/hooks/installation/windows-hook-command.test.ts',
  'src/main/codex/hooks/installation/hook-service-managed-install.test.ts',
  'src/main/windows/windows-pty-job.win32.test.ts',
  'src/main/windows/windows-msys-job.win32.test.ts',
  'src/main/providers/agent-foreground-process-git-bash.win32.test.ts',
  'src/main/windows/windows-host-job.win32.test.ts',
  'src/main/windows/windows-process-tree-command-line-patch.test.ts',
  'src/main/windows/windows-process-table-native-addon.win32.test.ts',
  'src/main/windows/windows-administrator-status.win32.test.ts',
  'src/main/windows/windows-administrator-restart.win32.test.ts',
  'src/main/daemon/endpoint/identity/testing/daemon-pid-identity-native.win32.test.ts',
  'src/main/daemon/pty-subprocess/testing/node-pty-conout-worker-errors.test.ts',
  'src/main/daemon/pty-subprocess/testing/node-pty-windows-output-error.win32.test.ts',
  'src/main/persistence/profile-state/profile-state-access-windows-native.win32.test.ts',
  'src/main/pty/process-retirement/windows-live-tree-kill.win32.test.ts',
  'src/main/wsl/execution/wsl-guest-environment.test.ts',
  'src/main/wsl/execution/wsl-executable-path.win32.test.ts',
  'src/main/claude-accounts/claude-profile-history-windows.test.ts',
  'src/shared/source-scan/source-tree-scan.test.ts',
  'src/main/cli/wsl-cli-powershell-boundary.test.ts',
  'src/main/computer/desktop-script-runtime-host.win32.test.ts',
  'src/main/cursor/hook-service.test.ts',
  'src/main/orca-profiles/profile-index-store.test.ts',
  'src/main/startup/windows-install-dir-acl-repair.win32.test.ts',
  'src/main/startup/windows-app-data-path.test.ts',
  'src/main/startup/windows-std-handle-inheritance.win32.test.ts',
  'src/main/startup/windows-isolated-spawner.win32.test.ts',
  'src/main/runtime/workspaces/catalog/worktree-scan-admin-fingerprint-gate.test.ts',
  'src/shared/secure-storage/secure-path-windows-acl.win32.test.ts',
  'src/main/runtime/rpc/server/pairing/unreadable-secret-store-preservation.win32.test.ts',
  'src/shared/perforce/workspace-copy/workspace-copy-remove-lock.test.ts',
  'src/main/ipc/preflight-provider-command-selection.test.ts',
  'src/main/ipc/preflight-runnable-local-cli.test.ts',
  'src/main/managed-server/install/remote-node-runtime-store-windows.test.ts',
  'src/main/skills/bundled-skill-install/bundled-skill-local-host.test.ts',
  'src/main/skills/bundled-skill-install/bundled-skill-plan-selection.test.ts'
]

const WINDOWS_PROCESS_PROBE_PREFIXES = [
  'config/nsis/',
  'config/scripts/nsis-process-check',
  'config/scripts/desktop-distribution/nsis/nsis-process-check',
  'config/scripts/idle-cpu-process-sampling',
  'config/scripts/performance/idle-cpu/idle-cpu-process-sampling',
  'config/vitest.config.',
  'config/scripts/vitest-',
  'config/scripts/test-runtime/environment/vitest-',
  'config/scripts/test-runtime/execution-policy/vitest-',
  'config/scripts/test-runtime/dom/vitest-',
  'config/scripts/test-runtime/module-cache/vitest-',
  'config/scripts/test-runtime/node-worker/vitest-',
  'config/scripts/test-runtime/sqlite-admission/vitest-',
  'config/scripts/ci-unit-',
  'config/scripts/ci/unit-selection/dependency-graph/ci-unit-',
  'config/scripts/ci/unit-selection/ci-unit-',
  'config/scripts/ci/unit-cache/ci-unit-',
  'config/scripts/ci/sharding/ci-unit-',
  'config/scripts/workspace-source-exports',
  'config/scripts/workspace/source-exports/workspace-source-exports',
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
  'config/scripts/desktop-distribution/nsis/nsis-process-check.test.mjs',
  'config/scripts/performance/idle-cpu/idle-cpu-process-sampling.test.mjs'
]

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(WINDOWS_BOUNDARY_TESTS.join('\n'))
}

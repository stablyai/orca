import { globSync } from 'node:fs'
import { defaultExclude } from 'vitest/config'

// Why one constant: the cross-version-wire job runs this directory, so a new file there runs with no list to update.
export const CROSS_VERSION_WIRE_DIR = 'tests/e2e/cross-version-wire/'

export const UNIT_INCLUDE = [
  'src/**/*.test.ts',
  'src/**/*.test.tsx',
  'config/scripts/**/*.test.ts',
  'config/scripts/**/*.test.mjs',
  'tests/tools/**/*.test.mjs',
  'tests/e2e/**/*.unit.test.ts'
]

export const UNIT_SETUP_FILES = [
  'config/scripts/test-runtime/environment/vitest-real-agent-home-write-guard.ts',
  'config/scripts/test-runtime/environment/vitest-bun-node-builtins.ts',
  'config/scripts/test-runtime/dom/vitest-dom-setup.ts',
  'config/scripts/test-runtime/environment/vitest-host-ports-setup.ts',
  'config/scripts/test-runtime/environment/vitest-caller-identity-env-setup.ts',
  'config/scripts/test-runtime/environment/vitest-inherited-git-env-setup.ts',
  'config/scripts/test-runtime/environment/vitest-orcad-feature-readiness-reset.ts'
]

export const UNIT_EXCLUDE = [
  ...defaultExclude,
  'src/main/daemon/shell-readiness/testing/repro-13767-shell-ready-marker-lost-to-exec.test.ts',
  'src/main/daemon/shell-readiness/testing/shell-ready.test.ts',
  'src/main/daemon/pty-subprocess/testing/node-pty-fd-leak.test.ts',
  'src/main/providers/local-pty/local-pty-shell-ready-zsh-launch-environment.test.ts',
  'src/main/pty/shell-startup/omp-shell-wrapper-alias-safety.test.ts',
  'src/main/pty/shell-startup/omp-shell-wrapper.node-pty.test.ts',
  'src/main/pty/shell-startup/shell-startup-feature-channel.test.ts',
  'src/main/pty/shell-startup/zsh-deferred-startup-line-init.live-shell.test.ts',
  'src/main/pty/history/terminal-history-fish-session.node-pty.test.ts',
  'src/main/pty/shell-startup/zsh-scoped-histfile.live-shell.test.ts',
  'src/main/pty/shell-startup/zsh-startup-hook-user-config-equivalence.live-shell.test.ts',
  'src/main/runtime/agent-session/environment/structured-session-cli-login-shell.live-shell.test.ts',
  'src/main/startup/shell-probe-terminal-detach.live-shell.test.ts',
  'src/main/startup/shell-probe-lifetime.live-shell.test.ts',
  'src/renderer/src/components/terminal-pane/fish-color-scheme-child-stdin.node-pty.test.ts',
  'src/shared/fish-query-reply-child-stdin.node-pty.test.ts',
  'src/shared/fish-wsl-cwd-report.node-pty.test.ts',
  'src/main/wsl/filesystem/wsl-sh-cwd-report.node-pty.test.ts',
  'src/shared/terminal/pty/ingress/pty-reply-echo-shapes.node-pty.test.ts',
  'src/shared/startup-shell-portability.live-shell.test.ts',
  'src/shared/posix-command-path-lookup.test.ts',
  'tests/e2e/relay-region-compatibility.unit.test.ts',
  'tests/e2e/relay-region-correction.unit.test.ts',
  'src/main/browser/cookies/browser-google-cookie-clear.electron.test.ts',
  // Electron probes with in-process deadlines; the package job runs them serially.
  'src/main/browser/guest-lifecycle/popups/popup-origin-chrome.electron.test.ts',
  'src/main/browser/guest-lifecycle/navigation/browser-link-materialization.electron.test.ts',
  'src/main/browser/client-pages/renderer/browser-client-page-renderer-lifecycle.electron.test.ts',
  'src/main/persistence/profile-state/profile-state-writer-stall.electron.test.ts',
  'src/main/browser/guest-lifecycle/popups/browser-popup-compatibility.electron.test.ts',
  'src/main/browser/guest-lifecycle/popups/browser-popup-adapter-compatibility.electron.test.ts',
  'src/main/browser/guest-lifecycle/popups/browser-popup-native-compatibility.electron.test.ts',
  'src/main/browser/guest-lifecycle/popups/browser-popup-background-compatibility.electron.test.ts',
  'src/main/browser/extensions/api-runtime/browser-extension-api.electron.test.ts',
  'src/main/browser/extensions/profile-storage/browser-extension-persistence.electron.test.ts',
  'src/main/browser/extensions/profile-sessions/browser-extension-lifecycle.electron.test.ts',
  'src/main/browser/extensions/actions/browser-extension-toolbar.electron.test.ts',
  'src/main/browser/extensions/native-messaging/browser-extension-native-messaging.electron.test.ts',
  `${CROSS_VERSION_WIRE_DIR}**`
]

export function discoverUnitFiles(root = process.cwd()) {
  return globSync(UNIT_INCLUDE, { cwd: root, exclude: UNIT_EXCLUDE })
    .map((file) => file.replaceAll('\\', '/'))
    .sort()
}

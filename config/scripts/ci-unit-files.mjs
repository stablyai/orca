import { globSync } from 'node:fs'
import { defaultExclude } from 'vitest/config'
import { UNIT_INCLUDE } from './unit-test-file-patterns.mjs'
export { UNIT_INCLUDE } from './unit-test-file-patterns.mjs'

// Why one constant: the cross-version-wire job runs this directory, so a new file there runs with no list to update.
export const CROSS_VERSION_WIRE_DIR = 'tests/e2e/cross-version-wire/'

export const UNIT_EXCLUDE = [
  ...defaultExclude,
  'src/main/daemon/repro-13767-shell-ready-marker-lost-to-exec.test.ts',
  'src/main/daemon/shell-ready.test.ts',
  'src/main/daemon/node-pty-fd-leak.test.ts',
  'src/main/providers/local-pty-shell-ready-zsh-launch-environment.test.ts',
  'src/main/providers/__tests__/shell-ready-framework-example.test.ts',
  'src/main/pty/omp-shell-wrapper-alias-safety.test.ts',
  'src/main/pty/omp-shell-wrapper.node-pty.test.ts',
  'src/main/shell-startup-feature-channel.test.ts',
  'src/main/zsh-deferred-startup-line-init.live-shell.test.ts',
  'src/main/terminal-history-fish-session.node-pty.test.ts',
  'src/main/zsh-scoped-histfile.live-shell.test.ts',
  'src/main/zsh-startup-hook-user-config-equivalence.live-shell.test.ts',
  'src/main/zsh-wrapper-version-mismatch.live-shell.test.ts',
  'src/main/runtime/structured-session-cli-login-shell.live-shell.test.ts',
  'src/renderer/src/components/terminal-pane/fish-color-scheme-child-stdin.node-pty.test.ts',
  'src/shared/fish-query-reply-child-stdin.node-pty.test.ts',
  'src/shared/pty-reply-echo-shapes.node-pty.test.ts',
  'src/shared/startup-shell-portability.live-shell.test.ts',
  'src/shared/posix-command-path-lookup.test.ts',
  'tests/e2e/relay-region-compatibility.unit.test.ts',
  'tests/e2e/relay-region-correction.unit.test.ts',
  `${CROSS_VERSION_WIRE_DIR}**`
]

export function discoverUnitFiles(root = process.cwd()) {
  return globSync(UNIT_INCLUDE, { cwd: root, exclude: UNIT_EXCLUDE })
    .map((file) => file.replaceAll('\\', '/'))
    .sort()
}

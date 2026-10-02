/** Mirrors ORCA_REQUIRED_TEST_INPUTS_ENV in src/main/orcad/orcad-node-slot-fixture.ts. */
export const REQUIRED_TEST_INPUTS_ENV = 'ORCA_REQUIRED_TEST_INPUTS'

// Need Bun 1.4.2 and the last Bun orcad slot beside the built Node slot (design D7).
export const CROSS_RUNTIME_TEST_PATHS = [
  'src/main/orcad/orcad-cross-runtime-daemon-adoption.integration.test.ts',
  'src/main/persistence/profile-state/profile-state-cross-runtime.integration.test.ts'
]

export function nodeServerTestPaths({ artifact = false, crossRuntime = false } = {}) {
  return [
    'src/main/persistence/profile-state',
    'src/main/persistence/loading-store/profile-state',
    'src/main/sqlite',
    'src/main/orcad/orcad-entry.test.ts',
    'src/main/orcad/orcad-push-startup.test.ts',
    // The directory, not a prefix: its siblings are POSIX-host unit tests pr.yml already runs.
    'src/main/daemon/pty-subprocess/',
    'src/main/daemon/pty-subprocess-spawn-file-foreground.test.ts',
    'src/main/daemon/pty-subprocess-io-failure-native.test.ts',
    ...(artifact
      ? [
          'tests/e2e/daemon-running-work-probe.unit.test.ts',
          'src/main/orcad/orcad-packaged-node-pty.integration.test.ts',
          'src/main/providers/agent-foreground-process-git-bash.win32.test.ts',
          'src/main/orcad/orcad-node-launcher.integration.test.ts',
          'config/scripts/zip-extractor-command.test.mjs'
        ]
      : []),
    ...(crossRuntime ? CROSS_RUNTIME_TEST_PATHS : [])
  ]
}

export const REQUIRED_TEST_INPUTS_ENV = 'ORCA_REQUIRED_TEST_INPUTS'

export function nodeServerTestPaths() {
  return [
    'src/main/persistence/profile-state',
    'src/main/persistence/loading-store/profile-writing/profile-state',
    'src/main/sqlite',
    // The orcad server's identity and stop path, which Windows SSH hosts rely on (W2).
    'src/main/orcad/instance-lock/orcad-instance-lock.test.ts',
    // The directory, not a prefix: its siblings are POSIX-host unit tests pr.yml already runs.
    'src/main/daemon/pty-subprocess/conpty-startup-input-reader.ts',
    'src/main/daemon/pty-subprocess/daemon-pty-physical-owner.ts',
    'src/main/daemon/pty-subprocess/foreground-fallback-process.ts',
    'src/main/daemon/pty-subprocess/foreground-process-tracker.ts',
    'src/main/daemon/pty-subprocess/native-pty-spawn.ts',
    'src/main/daemon/pty-subprocess/pre-listener-events.ts',
    'src/main/daemon/pty-subprocess/pty-shell-foreground-confirmation.ts',
    'src/main/daemon/pty-subprocess/shell-launch-plan.ts',
    'src/main/daemon/pty-subprocess/spawn-environment.ts',
    'src/main/daemon/pty-subprocess/spawn-file-child-processes.ts',
    'src/main/daemon/pty-subprocess/spawn-file-foreground-process.ts',
    'src/main/daemon/pty-subprocess/spawn-preflight.ts',
    'src/main/daemon/pty-subprocess/subprocess-handle.ts'
  ]
}

export function bunProfileTestPaths({ artifact = false } = {}) {
  return [
    'src/shared/bun-owned-runtime-args.integration.test.ts',
    'src/shared/child-process/fork-process-bun.integration.test.ts',
    'src/main/persistence/profile-state',
    'src/main/persistence/loading-store/profile-state',
    'src/main/sqlite',
    'src/main/orcad/orcad-entry.test.ts',
    'src/main/orcad/orcad-push-startup.test.ts',
    'src/shared/terminal-unicode-provider.test.ts',
    'src/main/daemon/headless-emulator-unicode-width.test.ts',
    'src/main/daemon/headless-emulator-fidelity.fuzz.test.ts',
    ...(artifact
      ? [
          'src/relay/windows-detached-launch.integration.test.ts',
          'src/main/daemon/pty-subprocess/bun-pty-process.integration.test.ts',
          'src/main/pty/posix-pty-process-groups.integration.test.ts',
          'src/main/daemon/pty-subprocess/bun-pty-job-control.integration.test.ts',
          'src/main/daemon/pty-subprocess/bun-pty-process-suspension.test.ts',
          'src/main/daemon/pty-subprocess-spawn-file-foreground.test.ts',
          'src/main/daemon/pty-subprocess/spawn-file-foreground-rejected-agents.test.ts',
          'tests/e2e/daemon-running-work-probe.unit.test.ts',
          'src/main/daemon/pty-subprocess/windows-bun-pty-gate.integration.test.ts',
          'src/main/windows/windows-pty-job.win32.test.ts',
          'src/main/daemon/bun-pty-windows-io-failure.win32.test.ts',
          'src/main/windows/windows-msys-job.win32.test.ts',
          'src/main/providers/windows-conpty-wide-char-duplication.bun.test.ts',
          'src/main/providers/pty-repaint-wide-char-buffer.bun.test.ts',
          'src/main/daemon/daemon-bun-pty-artifact.integration.test.ts',
          'src/main/providers/agent-foreground-process-git-bash.win32.test.ts',
          'src/main/orcad/orcad-bun-launcher.integration.test.ts',
          'config/scripts/zip-extractor-command.test.mjs',
          'config/scripts/orcad-launcher-build.test.mjs',
          'src/main/orcad/orcad-bundle-native-load-order.test.ts'
        ]
      : [])
  ]
}

export function bunProfileTestPaths({ artifact = false } = {}) {
  return [
    'src/main/persistence/profile-state',
    'src/main/persistence/loading-store/profile-state',
    'src/main/sqlite',
    'src/main/orcad/orcad-entry.test.ts',
    'src/main/orcad/orcad-push-startup.test.ts',
    ...(artifact
      ? [
          'src/main/daemon/pty-subprocess/bun-pty-process.integration.test.ts',
          'src/main/daemon/pty-subprocess/bun-pty-job-control.integration.test.ts',
          'src/main/daemon/pty-subprocess/bun-pty-process-suspension.test.ts',
          'src/main/daemon/pty-subprocess-spawn-file-foreground.test.ts',
          'src/main/daemon/pty-subprocess/spawn-file-foreground-rejected-agents.test.ts',
          'tests/e2e/daemon-running-work-probe.unit.test.ts',
          'src/main/daemon/pty-subprocess/windows-bun-pty-gate.integration.test.ts',
          'src/main/providers/local-pty-bun-artifact.integration.test.ts',
          'src/main/providers/agent-foreground-process-git-bash.win32.test.ts',
          'src/main/orcad/orcad-bun-launcher.integration.test.ts',
          'config/scripts/zip-extractor-command.test.mjs'
        ]
      : [])
  ]
}

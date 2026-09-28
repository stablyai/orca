import { join } from 'node:path'
import { describe, it } from 'vitest'
import { runBundledBunFixture } from '../bundled-bun-test-execution'

const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

describeOnWindows("Git Bash launcher shell proof with Orca's real launch", () => {
  it.each([
    ['login shell', {}],
    ['rcfile wrapper', { ORCA_CODEX_LAUNCH_PREFLIGHT: 'C:\\orca-missing-preflight.exe' }]
  ])(
    'confirms an idle %s prompt, refutes a running command, and confirms again',
    async (_label, extraEnv) => {
      await runBundledBunFixture(
        join(__dirname, 'git-bash-foreground-bun-fixture.ts'),
        'verifyGitBashForeground',
        extraEnv,
        60_000
      )
    },
    65_000
  )
})

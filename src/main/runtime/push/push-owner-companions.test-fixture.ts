import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { runProcess } from '@orca/process-host'

export function launchOwnerCompanions(
  root: string,
  base: string,
  abort: AbortController,
  closed: Set<string>
) {
  return ['cloud', 'mobile'].map(async (role) => {
    const cwd = role === 'cloud' ? join(root, 'cloud/apps/push') : join(root, 'mobile')
    const require = createRequire(join(cwd, 'package.json'))
    const cli = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
    return runProcess({
      program: process.execPath,
      args: [cli, 'run', '--config', join(root, `config/push-owner-${role}.vitest.config.mjs`)],
      cwd,
      env: {
        ...process.env,
        ORCA_BACKGROUND_LAUNCH: '1',
        ORCA_PUSH_OWNER_BRIDGE: base
      },
      signal: abort.signal,
      timeoutMs: 150_000,
      terminationBarrier: true,
      onChildTerminated: () => closed.add(role),
      stdio: 'inherit'
    })
  })
}

import { describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import type * as ProcessHost from '@orca/process-host'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetWslInteropSpawnDirectoryCache } from '../wsl/execution/wsl-interop-spawn-directory'

const { spawnProcessMock } = vi.hoisted(() => ({
  spawnProcessMock: vi.fn((..._args: unknown[]) => ({ pid: 1 }))
}))

vi.mock('@orca/process-host', async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessHost>()),
  spawnProcess: spawnProcessMock
}))
vi.mock('../wsl/execution/wsl-executable-path', () => ({
  resolveWslExecutablePath: () => 'C:\\Windows\\System32\\wsl.exe'
}))

import { spawnWslRelayProcess } from './wsl-hook-relay-launch'
import { orcadPosixNodeRuntimeGlobs } from '../managed-server/install/orcad-node-runtime-globs'

describe('spawnWslRelayProcess', () => {
  it('launches from the system directory instead of the current worktree', () => {
    const systemRoot = mkdtempSync(join(tmpdir(), 'wsl-relay-launch-'))
    const env = { ORCA_AGENT_HOOK_PORT: '1234' }
    vi.stubEnv('SystemRoot', systemRoot)
    resetWslInteropSpawnDirectoryCache()
    try {
      spawnWslRelayProcess('Ubuntu', env, '1.2.3')

      expect(spawnProcessMock).toHaveBeenCalledExactlyOnceWith({
        program: 'C:\\Windows\\System32\\wsl.exe',
        args: [
          '-d',
          'Ubuntu',
          '--exec',
          'sh',
          '-c',
          'exec sh "$HOME/.orca-wsl/hook-relay/1.2.3/launch.sh"'
        ],
        env,
        stdio: 'pipe',
        cwd: systemRoot
      })
    } finally {
      vi.unstubAllEnvs()
      resetWslInteropSpawnDirectoryCache()
      rmSync(systemRoot, { recursive: true, force: true })
    }
  })
})

describe('buildGuestLaunchScript', () => {
  it.skipIf(process.platform === 'win32')(
    'expands the orcad runtime globs to the store and machine-home runtimes',
    () => {
      const home = mkdtempSync(join(tmpdir(), 'wsl-relay-home-'))
      try {
        const runtimes = [
          join(home, '.orca-remote/runtimes/node-aaa/bin/node'),
          join(home, '.orca-remote/hosts/machine1/.orca-remote/runtimes/node-bbb/bin/node')
        ]
        for (const runtime of runtimes) {
          mkdirSync(join(runtime, '..'), { recursive: true })
          writeFileSync(runtime, '#!/bin/sh\n')
          chmodSync(runtime, 0o755)
        }
        const out = execFileSync(
          'sh',
          [
            '-c',
            `for c in ${orcadPosixNodeRuntimeGlobs().join(' ')}; do [ -x "$c" ] && echo "$c"; done`
          ],
          { env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' }
        )
        expect(out.trim().split('\n')).toEqual(runtimes)
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
  )
})

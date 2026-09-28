import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { buildGuestInstallScript } from '../agent-hooks/wsl-hook-relay-launch'
import { buildWslBrowserNetworkGuestInstallScript } from '../browser/wsl-browser-network-relay-launch'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.skipIf(process.platform === 'win32')('WSL Bun launcher scripts', () => {
  it.each([
    {
      directory: 'hook-relay',
      unavailableCode: 43,
      filename: 'wsl-agent-hook-relay.js',
      install: buildGuestInstallScript
    },
    {
      directory: 'browser-network',
      unavailableCode: 73,
      filename: 'wsl-browser-network-relay.js',
      install: buildWslBrowserNetworkGuestInstallScript
    }
  ])(
    'runs $directory with only the selected runtime, preserving literal paths',
    async ({ directory, filename, install, unavailableCode }) => {
      const home = await mkdtemp(join(tmpdir(), "orca '$ runtime "))
      roots.push(home)
      const version = '1.0.0+test'
      const env = { HOME: home, ORCA_WSL_HOOK_RELAY_VERSION: version }
      const installed = await runProcess({
        program: '/bin/sh',
        args: ['-c', install(Buffer.from('// bundle'), version)],
        env
      })
      expect(installed.code, installed.stderr).toBe(0)
      const executable = join(home, "bun '$ literal")
      await writeFile(executable, '#!/bin/sh\nprintf "%s\\n" "$@"\n')
      await chmod(executable, 0o700)
      const directoryPath = join(home, '.orca-wsl', directory, 'bun', version)
      const launched = await runProcess({
        program: '/bin/sh',
        args: [join(directoryPath, 'launch.sh'), executable],
        env
      })
      expect(launched.code, launched.stderr).toBe(0)
      expect(launched.stdout.trimEnd().split('\n')).toEqual([
        '--no-env-file',
        '--config=/dev/null',
        '--no-install',
        join(directoryPath, filename)
      ])
      const missing = await runProcess({
        program: '/bin/sh',
        args: [join(directoryPath, 'launch.sh')],
        env
      })
      expect(missing.code).toBe(unavailableCode)
    }
  )
})

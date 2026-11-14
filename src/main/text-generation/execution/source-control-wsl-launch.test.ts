import type * as ChildProcess from 'node:child_process'
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi, afterEach } from 'vitest'
import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'
import '../../../shared/windows-command-line-budget'
import { withPlatform } from './commit-message-text-generation-test-harness'
import { spawnSourceControlAgent } from './source-control-agent-launch'
import './source-control-local-generation'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof ChildProcess>()
  spawnMock.mockImplementation(actual.spawn)
  return { ...actual, spawn: spawnMock }
})
vi.mock('../../wsl/discovery/wsl-background-distro-gate', () => ({
  noteWslDistroLaunched: vi.fn()
}))
const nativeSpawn = (await vi.importActual<typeof ChildProcess>('node:child_process')).spawn
afterEach(() => {
  spawnMock.mockReset().mockImplementation(nativeSpawn)
})

it.skipIf(process.platform === 'win32')(
  'clears profile-restored hook identity after login while preserving shell function commands',
  async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'orca-wsl-hook-isolation-')))
    const profile = join(directory, 'rc')
    const shell = join(directory, 'bash')
    const reader = join(directory, 'reader.cjs')
    writeFileSync(
      shell,
      `#!/bin/sh\nexec /bin/bash --noprofile --rcfile ${quotePosixShell(profile)} -ic "$2"\n`,
      { mode: 0o700 }
    )
    writeFileSync(
      join(directory, 'getent'),
      `#!/bin/sh\nprintf '%s\\n' ${quotePosixShell(`user:x:1:1:User:${directory}:${shell}`)}\n`,
      { mode: 0o700 }
    )
    writeFileSync(
      profile,
      `export ORCA_PANE_KEY=profile-pane ORCA_AGENT_PANE=profile-pane ORCA_AGENT_HOOK_PORT=54321 ORCA_AGENT_HOOKS_DISABLED=0
export CODEX_HOME=profile-managed-home
review_agent() { ${quotePosixShell(process.execPath)} ${quotePosixShell(reader)} "$@"; }
`
    )
    writeFileSync(
      reader,
      `console.log(JSON.stringify({
  pane: process.env.ORCA_PANE_KEY ?? null,
  alias: process.env.ORCA_AGENT_PANE ?? null,
  port: process.env.ORCA_AGENT_HOOK_PORT ?? null,
  disabled: process.env.ORCA_AGENT_HOOKS_DISABLED,
  home: process.env.CODEX_HOME,
  args: process.argv.slice(2)
}))
`
    )
    // Run the real guest login command locally; only replace the Windows executable boundary.
    spawnMock.mockImplementationOnce((_program, args, options) =>
      nativeSpawn('/bin/sh', ['-c', args.at(-1)], options)
    )
    try {
      const child = withPlatform('win32', () =>
        spawnSourceControlAgent({
          binary: 'review_agent',
          args: ['literal $HOME'],
          wslDistro: 'Review',
          env: {
            ...process.env,
            HOME: directory,
            SHELL: shell,
            PATH: `${directory}:${process.env.PATH}`
          },
          stdinMode: 'pipe',
          useCwdForNative: true
        })
      )
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk) => (stdout += chunk))
      child.stderr?.on('data', (chunk) => (stderr += chunk))
      const closed = new Promise<number | null>((resolve, reject) => {
        child.on('error', reject)
        child.on('close', resolve)
      })
      child.stdin?.end()
      expect(await closed, stderr).toBe(0)
      expect(JSON.parse(stdout)).toEqual({
        pane: null,
        alias: null,
        port: null,
        disabled: '1',
        home: 'profile-managed-home',
        args: ['literal $HOME']
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)

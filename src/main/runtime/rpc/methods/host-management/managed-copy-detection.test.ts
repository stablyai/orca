import { mkdir, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { AgentStartupShell } from '../../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { readHostManagedAgentCommands } from './managed-copy-detection'
import { alignManagedAgentLaunchAtSpawn } from '../../../../managed-agent-cli/managed-agent-spawn-program'

vi.mock('../../../../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/data/orca'
}))

it('keeps the stock Claude name on an unquoted PATH for every shell', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-claude-path-'))
  const bin = join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude')
  const shells: (AgentStartupShell | undefined)[] = ['powershell', 'cmd', 'posix', undefined]
  try {
    await writeFile(bin, '', { mode: 0o755 })
    for (const shell of shells) {
      expect(await readHostManagedAgentCommands({}, ['claude'], { pathEnv: dir, shell })).toEqual(
        {}
      )
    }
  } finally {
    await unlink(bin)
    await rmdir(dir)
  }
})

it.runIf(process.platform === 'win32')(
  'uses the destination shell for a quoted PATH entry',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca claude path '))
    const bin = join(dir, 'claude.exe')
    const pathEnv = `"${dir}"`
    try {
      await writeFile(bin, '')
      expect(
        await readHostManagedAgentCommands({}, ['claude'], { pathEnv, shell: 'powershell' })
      ).toEqual({ claude: bin })
      expect(await readHostManagedAgentCommands({}, ['claude'], { pathEnv, shell: 'cmd' })).toEqual(
        {}
      )
      expect(
        await readHostManagedAgentCommands({}, ['claude'], { pathEnv, shell: 'posix' })
      ).toEqual({})
      expect(await readHostManagedAgentCommands({}, ['claude'], { pathEnv })).toEqual({
        claude: bin
      })
    } finally {
      await unlink(bin)
      await rmdir(dir)
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'uses a reattached cwd and inline PATH to replace a retired managed path with the stock name',
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orca-queued-launch-'))
    const repo = join(cwd, 'repo')
    const tools = join(repo, 'tools')
    const bin = join(tools, 'claude')
    try {
      await mkdir(tools, { recursive: true })
      await writeFile(bin, '', { mode: 0o755 })
      expect(
        await alignManagedAgentLaunchAtSpawn(
          {
            launchCommand:
              "cd repo && env PATH=./tools '/data/orca/agent-runtimes/claude/1.0/claude' --resume abc",
            readCwd: async () => cwd,
            queuedPath: '/spawn/bin',
            getSettings: () => ({})
          },
          'posix'
        )
      ).toBe('cd repo && env PATH=./tools claude --resume abc')
    } finally {
      await unlink(bin)
      await rmdir(tools)
      await rmdir(repo)
      await rmdir(cwd)
    }
  }
)

import {
  mkdtempSync,
  readFileSync,
  existsSync,
  statSync,
  rmSync,
  symlinkSync,
  mkdirSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { hashWorktreeId } from '../terminal-history-id'
import { prepareWslGuestTerminalHistory } from './wsl-guest-terminal-history'
import type { createRunningWslRuntimeRunner } from './wsl-bun-runtime'
import type { PtySpawnOptions } from '../providers/types'

const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'orca-guest-history-'))
  directories.push(home)
  const owner = {
    distro: 'Ubuntu',
    userName: 'captured',
    userId: String(process.getuid?.() ?? 0),
    home
  }
  const run = vi.fn<ReturnType<typeof createRunningWslRuntimeRunner>['run']>(async (spec) => {
    const args = spec.args ?? []
    expect(args).toEqual(
      expect.arrayContaining(['--no-env-file', '--config=/dev/null', '--no-install'])
    )
    const script = args.indexOf('-e')
    const result = await runProcess({
      program: process.execPath,
      args: args.slice(script),
      env: { ...process.env, HOME: home }
    })
    if (result.code !== 0) {
      throw new Error(result.stderr)
    }
    return result.stdout.trim()
  })
  const options: PtySpawnOptions = {
    cols: 80,
    rows: 24,
    worktreeId: 'folder-workspace',
    historyIsolationEnabled: true,
    env: { ORCA_USER_DATA_PATH: 'C:\\Orca\\profile-a' }
  }
  const invoke = (
    env: Record<string, string>,
    shell: string,
    override: Partial<PtySpawnOptions> = {}
  ) =>
    prepareWslGuestTerminalHistory(
      { run },
      owner,
      '/bun',
      '/usr/bin/env',
      { ...options, ...override },
      env,
      shell
    )
  return { home, owner, run, options, invoke }
}

describe.skipIf(process.platform === 'win32')('guest history scripts on a real filesystem', () => {
  it.each(['bash', 'zsh'])(
    'isolates %s history and writes owner-private metadata',
    async (shell) => {
      const { invoke, home, options } = fixture()
      const env: Record<string, string> = { HOME: home }
      await invoke(env, `/bin/${shell}`)
      const directory = posix.join(
        home,
        '.orca-wsl',
        hashWorktreeId(options.env!.ORCA_USER_DATA_PATH),
        'terminal-history',
        hashWorktreeId('folder-workspace')
      )
      expect(env.HISTFILE).toBe(`${directory}/${shell}_history`)
      expect(env.ORCA_HISTFILE).toBe(env.HISTFILE)
      const meta = JSON.parse(readFileSync(join(directory, 'meta.json'), 'utf8'))
      expect(meta.worktreeId).toBe('folder-workspace')
      expect(statSync(directory).mode & 0o777).toBe(0o700)
      expect(statSync(join(directory, 'meta.json')).mode & 0o777).toBe(0o600)
      await invoke({}, `/bin/${shell}`)
      expect(JSON.parse(readFileSync(join(directory, 'meta.json'), 'utf8')).createdAt).toBe(
        meta.createdAt
      )
    }
  )

  it('uses fish session names and its real guest XDG data directory', async () => {
    const { invoke, home, options } = fixture()
    const env: Record<string, string> = { HOME: home, XDG_DATA_HOME: `${home}/custom-data` }
    await invoke(env, '/usr/bin/fish')
    expect(env.fish_history).toMatch(/^orca_relay_[0-9a-f]{16}$/)
    expect(env).not.toHaveProperty('HISTFILE')
    expect(env.XDG_DATA_HOME).toBe(`${home}/custom-data`)
    const metaPath = join(
      home,
      '.orca-wsl',
      hashWorktreeId(options.env!.ORCA_USER_DATA_PATH),
      'terminal-history',
      hashWorktreeId('folder-workspace'),
      'meta.json'
    )
    expect(JSON.parse(readFileSync(metaPath, 'utf8'))).toMatchObject({
      fishSession: env.fish_history,
      fishHistoryDir: `${home}/custom-data/fish`
    })
  })

  it('keeps profiles and worktree/folder IDs separate', async () => {
    const { invoke } = fixture()
    const a: Record<string, string> = {},
      b: Record<string, string> = {},
      c: Record<string, string> = {}
    await invoke(a, '/bin/bash')
    await invoke(b, '/bin/bash', { worktreeId: 'git-worktree' })
    await invoke(c, '/bin/bash', { env: { ORCA_USER_DATA_PATH: 'C:\\Orca\\profile-b' } })
    expect(new Set([a.HISTFILE, b.HISTFILE, c.HISTFILE]).size).toBe(3)
  })

  it('checks UID before creating any guest history directory', async () => {
    const { run, owner, home, options } = fixture()
    await expect(
      prepareWslGuestTerminalHistory(
        { run },
        { ...owner, userId: String(Number(owner.userId) + 1) },
        '/bun',
        '/usr/bin/env',
        options,
        {},
        '/bin/bash'
      )
    ).rejects.toThrow('owner changed')
    expect(existsSync(join(home, '.orca-wsl'))).toBe(false)
  })

  it('refuses symlinked history roots instead of writing outside its owner tree', async () => {
    const { invoke, home } = fixture()
    const outside = join(home, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(home, '.orca-wsl'))
    await expect(invoke({}, '/bin/bash')).rejects.toThrow('not owned')
    expect(existsSync(join(outside, 'terminal-history'))).toBe(false)
  })
})

it('leaves explicit user history untouched and skips disabled/unsupported cases', async () => {
  const { invoke, run } = fixture()
  const bash = { HISTFILE: '/custom/history', ORCA_HISTFILE: '/old/orca' }
  await invoke(bash, '/bin/bash')
  expect(bash).toEqual({ HISTFILE: '/custom/history' })
  const fish = { fish_history: 'my-session' }
  await invoke(fish, '/bin/fish')
  expect(fish).toEqual({ fish_history: 'my-session' })
  const off = { HISTFILE: '/inherited', ORCA_HISTFILE: '/unchanged' }
  await invoke(off, '/bin/bash', { historyIsolationEnabled: false })
  expect(off.ORCA_HISTFILE).toBe('/unchanged')
  await invoke({}, '/bin/bash', { worktreeId: undefined })
  await invoke({}, '/bin/sh')
  expect(run).not.toHaveBeenCalled()
})

it.skipIf(process.platform === 'win32')(
  'replaces only inherited Orca-owned history settings',
  async () => {
    const { invoke } = fixture()
    const env = {
      HISTFILE: '/old/terminal-history/0123456789abcdef/bash_history',
      ORCA_HISTFILE: '/old',
      fish_history: 'orca_0123456789abcdef'
    }
    await invoke(env, '/bin/bash')
    expect(env.HISTFILE).not.toContain('/old/')
    expect(env.ORCA_HISTFILE).toBe(env.HISTFILE)
    expect(env).not.toHaveProperty('fish_history')
  }
)

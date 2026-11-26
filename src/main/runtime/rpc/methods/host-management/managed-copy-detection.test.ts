import { mkdir, mkdtemp, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { buildAgentStartupPlan } from '../../../../../shared/agent-launch/startup/tui-agent-startup'
import type { AgentStartupShell } from '../../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { agentSessionSignInCommand } from '../../../../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import { readHostManagedAgentCommands } from './managed-copy-detection'
import { alignManagedAgentLaunchAtSpawn } from '../../../../managed-agent-cli/managed-agent-spawn-program'
import { rememberManagedAgentRelease } from '../../../../managed-agent-cli/managed-agent-cli-registry'

vi.mock('../../../../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => (process.platform === 'win32' ? 'C:\\data\\orca' : '/data/orca')
}))
vi.mock('../../../../startup/shell-environment/login-shell-environment', () => ({
  captureLoginShellEnvironment: async () => ({ status: 'fallback', env: {} })
}))
vi.mock('../../../../../shared/shell/command-resolution/system-cli-install-dirs', () => ({
  getSystemCliInstallDirectories: () => []
}))

it("leaves Claude terminals to the shell and uses Orca's Claude for native chat sign-in", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-claude-sign-in-'))
  const release = join(dir, 'agent-runtimes', 'claude', '1.0')
  const windows = process.platform === 'win32'
  const shell = windows ? 'powershell' : 'posix'
  const bin = join(release, windows ? 'claude.exe' : 'claude')
  const plan = (claude: string) =>
    buildAgentStartupPlan({
      agent: 'claude',
      platform: process.platform,
      shell,
      prompt: '',
      allowEmptyPromptLaunch: true,
      cmdOverrides: {},
      managedAgentCommands: { claude }
    })
  const prepare = (launchCommand: string | undefined) =>
    alignManagedAgentLaunchAtSpawn(
      { launchCommand, queuedPath: dir, getSettings: () => ({}) },
      shell
    )
  try {
    await mkdir(release, { recursive: true })
    await writeFile(bin, '', { mode: 0o755 })
    rememberManagedAgentRelease('claude', release)
    vi.stubEnv(windows ? 'USERPROFILE' : 'HOME', dir)
    vi.stubEnv('FNM_DIR', dir)

    expect(await readHostManagedAgentCommands({}, ['claude'], { pathEnv: dir, shell })).toEqual({})
    expect(plan(bin)?.launchCommand).toBe('claude')
    expect(
      plan(windows ? 'C:\\user\\.local\\bin\\claude.exe' : '/user/.local/bin/claude')?.launchCommand
    ).toBe(windows ? "& 'C:\\user\\.local\\bin\\claude.exe'" : "'/user/.local/bin/claude'")
    expect(await prepare('claude --verbose')).toBe('claude --verbose')
    expect(
      await prepare(
        windows
          ? "& 'C:\\data\\orca\\agent-runtimes\\claude\\1.0\\claude.exe' --verbose"
          : "'/data/orca/agent-runtimes/claude/1.0/claude' --verbose"
      )
    ).toBe(windows ? '& claude --verbose' : 'claude --verbose')
    const userCommand = windows
      ? "& 'C:\\user\\agent-runtimes\\claude\\1.0\\claude.exe' --verbose"
      : "'/user/agent-runtimes/claude/1.0/claude' --verbose"
    expect(await prepare(userCommand)).toBe(userCommand)

    const signIn = agentSessionSignInCommand('claude', { account: 'system', remote: false, shell })
    const preparedSignIn = await prepare(signIn ?? undefined)
    expect(preparedSignIn).toContain(bin)
    expect(preparedSignIn).toContain(' auth login')
  } finally {
    rememberManagedAgentRelease('claude', null)
    vi.unstubAllEnvs()
    await rm(dir, { recursive: true, force: true })
  }
})

it('keeps the stock Codex name on an unquoted PATH for every shell', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orca-codex-path-'))
  const bin = join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex')
  const shells: (AgentStartupShell | undefined)[] = ['powershell', 'cmd', 'posix', undefined]
  try {
    await writeFile(bin, '', { mode: 0o755 })
    for (const shell of shells) {
      expect(await readHostManagedAgentCommands({}, ['codex'], { pathEnv: dir, shell })).toEqual({})
    }
  } finally {
    await unlink(bin)
    await rmdir(dir)
  }
})

it.runIf(process.platform === 'win32')(
  'uses the destination shell for a quoted PATH entry',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca codex path '))
    const bin = join(dir, 'codex.exe')
    const pathEnv = `"${dir}"`
    try {
      await writeFile(bin, '')
      expect(
        await readHostManagedAgentCommands({}, ['codex'], { pathEnv, shell: 'powershell' })
      ).toEqual({ codex: bin })
      expect(await readHostManagedAgentCommands({}, ['codex'], { pathEnv, shell: 'cmd' })).toEqual(
        {}
      )
      expect(
        await readHostManagedAgentCommands({}, ['codex'], { pathEnv, shell: 'posix' })
      ).toEqual({})
      expect(await readHostManagedAgentCommands({}, ['codex'], { pathEnv })).toEqual({
        codex: bin
      })
    } finally {
      await unlink(bin)
      await rmdir(dir)
    }
  }
)

it.runIf(process.platform === 'win32')(
  'uses codex.exe from PATH or Orca when PATH also contains codex.cmd',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-codex-path-'))
    const a = join(dir, 'A')
    const b = join(dir, 'B')
    const exe = join(b, 'codex.exe')
    const managed = join(dir, 'managed')
    const managedExe = join(managed, 'bin', 'codex.exe')
    const launch = (queuedPath: string) =>
      alignManagedAgentLaunchAtSpawn(
        {
          launchCommand: 'codex.exe --version',
          queuedPath,
          getSettings: () => ({ agentCmdOverrides: { codex: 'codex.exe' } })
        },
        'powershell'
      )
    try {
      await mkdir(a)
      await mkdir(b)
      await writeFile(join(a, 'codex.cmd'), '')
      await writeFile(exe, '')
      expect(await launch(`${a};${b}`)).toBe('codex.exe --version')
      expect(await launch(`${a};"${b}"`)).toBe(`& '${exe}' --version`)

      await mkdir(join(managed, 'bin'), { recursive: true })
      await writeFile(managedExe, '')
      rememberManagedAgentRelease('codex', managed)
      vi.stubEnv('USERPROFILE', dir)
      vi.stubEnv('FNM_DIR', dir)
      expect(await launch(a)).toBe(`& '${managedExe}' --version`)
      expect(
        await alignManagedAgentLaunchAtSpawn(
          {
            launchCommand: '.\\B\\codex --version',
            cwd: dir,
            queuedPath: '',
            getSettings: () => ({})
          },
          'powershell'
        )
      ).toBe('.\\B\\codex --version')
    } finally {
      rememberManagedAgentRelease('codex', null)
      vi.unstubAllEnvs()
      await rm(dir, { recursive: true, force: true })
    }
  }
)

it.runIf(process.platform === 'win32')(
  'keeps the stock Codex name when a quoted user PATH entry precedes an unquoted one',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-codex-path-'))
    const quoted = join(dir, 'quoted bin')
    const unquoted = join(dir, 'unquoted')
    const pathEnv = `"${quoted}";${unquoted}`
    try {
      for (const folder of [quoted, unquoted]) {
        await mkdir(folder)
        await writeFile(join(folder, 'codex.exe'), '')
      }
      expect(
        await readHostManagedAgentCommands({}, ['codex'], {
          pathEnv,
          shell: 'powershell',
          forDelivery: true
        })
      ).toEqual({})
      expect(
        await readHostManagedAgentCommands({}, ['codex'], {
          pathEnv,
          shell: 'cmd',
          forDelivery: true
        })
      ).toEqual({})
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
)

it.skipIf(process.platform === 'win32')(
  'uses a reattached cwd and inline PATH to replace a retired managed path with the stock name',
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'orca-queued-launch-'))
    const repo = join(cwd, 'repo')
    const tools = join(repo, 'tools')
    const bin = join(tools, 'codex')
    try {
      await mkdir(tools, { recursive: true })
      await writeFile(bin, '', { mode: 0o755 })
      expect(
        await alignManagedAgentLaunchAtSpawn(
          {
            launchCommand:
              "cd repo && env PATH=./tools '/data/orca/agent-runtimes/codex/1.0/bin/codex' --resume abc",
            readCwd: async () => cwd,
            queuedPath: '/spawn/bin',
            getSettings: () => ({})
          },
          'posix'
        )
      ).toBe('cd repo && env PATH=./tools codex --resume abc')
    } finally {
      await unlink(bin)
      await rmdir(tools)
      await rmdir(repo)
      await rmdir(cwd)
    }
  }
)

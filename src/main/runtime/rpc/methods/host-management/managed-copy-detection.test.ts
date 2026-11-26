import { mkdir, mkdtemp, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { buildAgentStartupPlan } from '../../../../../shared/agent-launch/startup/tui-agent-startup'
import type { AgentStartupShell } from '../../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { agentSessionSignInCommand } from '../../../../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import { readHostManagedAgentCommands } from './managed-copy-detection'
import { alignManagedAgentLaunchAtSpawn } from '../../../../managed-agent-cli/managed-agent-spawn-program'
import { prepareNativeChatSignIn } from '../../../../managed-agent-cli/prepare-native-chat-sign-in'
import { detectInstalledAgentInventory } from '../../../../preflight/installed-agent-detection'
import { notifyAgentsRefreshedOnHost } from '../../../../preflight/agents-refreshed-on-host'
import { launchProgramHead } from '../../../../../shared/agent-launch/startup/managed-agent-launch-program'
import { mayResolveQueuedAgentLaunch } from '../../../../../shared/agent-launch/startup/queued-agent-launch'
import { readLaunchPosition } from '../../../../../shared/agent-launch/startup/launch-position'
import {
  managedAgentCli,
  rememberManagedAgentRelease
} from '../../../../managed-agent-cli/managed-agent-cli-registry'

const profile = vi.hoisted(() => ({ path: '', detectionPath: '' }))
vi.mock('../../../../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => profile.path
}))
vi.mock('../../../../startup/shell-environment/login-shell-environment', () => ({
  captureLoginShellEnvironment: async () => ({ status: 'fallback', env: {} }),
  resolveLoginShellEnvironment: async () => ({ PATH: profile.path })
}))
vi.mock('../../../../ipc/preflight/preflight-local-env', () => ({
  buildLocalPreflightEnv: () => ({ PATH: profile.detectionPath || profile.path })
}))
vi.mock('../../../../../shared/shell/command-resolution/system-cli-install-dirs', () => ({
  getSystemCliInstallDirectories: () => []
}))

it.each(['claude', 'codex'] as const)(
  'keeps %s terminal launches on the user CLI while allowing native-chat sign-in',
  async (agent) => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-agent-terminal-'))
    profile.path = dir
    const cli = managedAgentCli(agent)
    const release = join(cli.runtime.root(dir), '1.0')
    const bin = cli.executable(release)
    const windows = process.platform === 'win32'
    const shell = windows ? 'powershell' : 'posix'
    const pathEnv = dirname(bin)
    const prepare = (launchCommand: string | undefined) =>
      alignManagedAgentLaunchAtSpawn({ launchCommand, queuedPath: pathEnv }, shell)
    const plannedCommand = (
      managedAgentCommands: Partial<Record<typeof agent, string>>,
      cmdOverrides = {}
    ) =>
      buildAgentStartupPlan({
        agent,
        platform: process.platform,
        shell,
        prompt: '',
        allowEmptyPromptLaunch: true,
        cmdOverrides,
        managedAgentCommands
      })?.launchCommand
    const plannedProgram = (managedAgentCommands: Partial<Record<typeof agent, string>>) =>
      readLaunchPosition(plannedCommand(managedAgentCommands) ?? '', shell)?.executable
    try {
      await mkdir(pathEnv, { recursive: true })
      await writeFile(bin, '', { mode: 0o755 })
      rememberManagedAgentRelease(agent, release)
      vi.stubEnv(windows ? 'USERPROFILE' : 'HOME', dir)
      vi.stubEnv('FNM_DIR', dir)

      const commands = await readHostManagedAgentCommands({}, [agent], { pathEnv, shell })
      expect(commands).toEqual({})
      expect(plannedProgram(commands)).toBe(agent)
      const stock = `${agent} --version`
      expect(mayResolveQueuedAgentLaunch(stock, shell)).toBe(false)
      expect(await prepare(stock)).toBe(stock)
      const saved = `${launchProgramHead(bin, shell)} --version`
      expect(mayResolveQueuedAgentLaunch(saved, shell)).toBe(true)
      expect(await prepare(saved)).toBe(windows ? `& ${stock}` : stock)

      const overrides = { agentCmdOverrides: { [agent]: launchProgramHead(bin, shell) } }
      expect((await detectInstalledAgentInventory(undefined, overrides)).agents).toContain(agent)
      expect(
        await alignManagedAgentLaunchAtSpawn(
          { launchCommand: saved, queuedPath: pathEnv, getSettings: () => overrides },
          shell
        )
      ).toBe(saved)

      const userPath = join(
        dir,
        'user',
        'agent-runtimes',
        agent,
        '1.0',
        windows ? `${agent}.exe` : agent
      )
      const userCommand = launchProgramHead(userPath, shell)
      expect(plannedProgram({ [agent]: userPath })).toBe(userPath)
      expect(await prepare(`${userCommand} --version`)).toBe(`${userCommand} --version`)

      if (agent === 'claude') {
        const signIn = agentSessionSignInCommand(agent, { account: 'system', remote: false, shell })
        const preparedSignIn = await prepare(signIn ?? undefined)
        expect(preparedSignIn).toContain(bin)
        expect(preparedSignIn).toContain(' auth login')

        const ownDir = join(dir, '.local', 'bin')
        const ownBin = join(ownDir, windows ? 'claude.exe' : 'claude')
        await mkdir(ownDir, { recursive: true })
        await writeFile(ownBin, '', { mode: 0o755 })
        notifyAgentsRefreshedOnHost(true)
        const stockOverride = { agentCmdOverrides: { claude: 'claude --verbose' } }
        const ownProgram = windows ? `& '${ownBin}'` : `'${ownBin}'`
        const outsidePath = await readHostManagedAgentCommands(stockOverride, ['claude'], {
          pathEnv: dir,
          shell
        })
        expect(outsidePath).toEqual({ claude: ownBin })
        expect(plannedCommand(outsidePath, stockOverride.agentCmdOverrides)).toContain(
          `${ownProgram} --verbose`
        )
        const restored = await alignManagedAgentLaunchAtSpawn(
          { launchCommand: saved, queuedPath: dir, getSettings: () => stockOverride },
          shell
        )
        expect(restored).toBe(`${ownProgram} --version`)

        const shadowedPath = [pathEnv, ownDir, dir].join(delimiter)
        profile.detectionPath = shadowedPath
        expect((await detectInstalledAgentInventory()).outsidePath?.claude).toBe(ownBin)
        expect(
          await alignManagedAgentLaunchAtSpawn(
            { launchCommand: saved, queuedPath: shadowedPath },
            shell
          )
        ).toBe(`${ownProgram} --version`)
      } else {
        const signIn = await prepareNativeChatSignIn(
          { kind: 'local' },
          {},
          { agent, account: 'system', remote: true }
        )
        expect(signIn).toContain(bin)
        expect(signIn).toContain('--device-auth')
        expect(await prepare(signIn ?? undefined)).toBe(signIn)
      }
    } finally {
      rememberManagedAgentRelease(agent, null)
      profile.detectionPath = ''
      vi.unstubAllEnvs()
      await rm(dir, { recursive: true, force: true })
    }
  }
)

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
          shell: 'powershell'
        })
      ).toEqual({})
      expect(
        await readHostManagedAgentCommands({}, ['codex'], {
          pathEnv,
          shell: 'cmd'
        })
      ).toEqual({})
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
)

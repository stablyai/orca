import type * as PreflightRuntimeTarget from '../../../../ipc/preflight/preflight-runtime-target'
import type * as InstallerDetection from '../../../../../shared/agent-launch/installation/local-agent-install-dir-detection'
import type * as NodeOs from 'node:os'
import type * as AppEnvironment from '../../../../../shared/app-lifecycle/app-environment'
import type * as WslDefaultDistro from '../../../../wsl/discovery/wsl-default-distro'
import type * as WslRunner from '../../../../wsl/execution/wsl-runner'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { alignManagedAgentLaunchAtSpawn } from '../../../../managed-agent-cli/managed-agent-spawn-program'
import { detectInstalledAgentInventory } from '../../../../preflight/installed-agent-detection'
import {
  detectAgentCommandsOnHost,
  readLocalTerminalAgentProgram,
  readWslTerminalAgentProgram
} from '../../../../preflight/agent-command-detection'
import { invalidateWslGuestEnvironment } from '../../../../wsl/execution/wsl-guest-environment'
import { refreshAgentsOnHost } from '../../../../preflight/workspace-agent-detection'
import { resolveClaudeTeamsInvocation } from '../../../terminal/launch/claude-teams-invocation'

const fixture = vi.hoisted(() => {
  const pending: { installs?: Promise<void>; onScan?: () => void } = {}
  return Object.assign(pending, {
    root: '',
    path: '',
    enumerate: vi.fn(() => []),
    wslProcess: vi.fn(async (): Promise<WslRunner.WslResult> => ({
      code: 0,
      stdout: '__ORCA_AGENT_PATH__claude\t/opt/tools/bin/claude\n',
      stderr: '',
      timedOut: false,
      environmentResolved: true
    }))
  })
})

vi.mock('../../../../../shared/app-lifecycle/app-environment', async (original) => {
  const environment = await original<typeof AppEnvironment>()
  return {
    ...environment,
    hasAppEnvironment: () => fixture.root !== '' && environment.hasAppEnvironment()
  }
})
vi.mock('../../../../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => fixture.root
}))
vi.mock('node:os', async (original) => ({
  ...(await original<typeof NodeOs>()),
  homedir: () => fixture.root
}))
vi.mock('../../../../ipc/preflight/preflight-local-env', () => ({
  buildLocalPreflightEnv: () => ({ PATH: fixture.path, PATHEXT: '.EXE;.CMD' })
}))
vi.mock('../../../../../shared/shell/command-resolution/fnm-default-alias-dirs', () => ({
  getFnmDefaultAliasDirectories: () => []
}))
vi.mock('../../../../../shared/shell/command-resolution/system-cli-install-dirs', () => ({
  getSystemCliInstallDirectories: fixture.enumerate
}))
vi.mock(
  '../../../../../shared/agent-launch/installation/local-agent-install-dir-detection',
  async (original) => {
    const detection = await original<typeof InstallerDetection>()
    return {
      detectCommandsInInstallDirs: async (
        ...args: Parameters<typeof detection.detectCommandsInInstallDirs>
      ) => {
        const pending = fixture.installs
        fixture.onScan?.()
        await pending
        return detection.detectCommandsInInstallDirs(...args)
      }
    }
  }
)
vi.mock('../../../../ipc/preflight/preflight-runtime-target', async (original) => {
  const target = await original<typeof PreflightRuntimeTarget>()
  return {
    getPreflightWslTarget: (context?: PreflightRuntimeTarget.PreflightRuntimeContext) =>
      target.getPreflightWslTarget(context, 'win32')
  }
})
vi.mock('../../../../wsl/discovery/wsl-default-distro', async (original) => ({
  ...(await original<typeof WslDefaultDistro>()),
  resolveWslDefaultDistro: async () => 'TestUbuntu'
}))
vi.mock('../../../../wsl/execution/wsl-runner', async (original) => ({
  ...(await original<typeof WslRunner>()),
  runWslProcess: fixture.wslProcess
}))

const windows = process.platform === 'win32'
const shell = windows ? 'powershell' : 'posix'
const claudeName = windows ? 'claude.exe' : 'claude'
const quoted = (file: string) => (windows ? `& '${file}'` : `'${file}'`)
const legacy = (agentCommand: string) => ({ agentCommand, agentArgs: '--verbose', agentEnv: {} })

beforeEach(async () => {
  fixture.root = await mkdtemp(join(tmpdir(), 'orca-terminal-inventory-'))
  fixture.path = join(fixture.root, 'path')
  fixture.enumerate.mockClear()
  fixture.wslProcess.mockReset()
})

afterEach(async () => {
  vi.useRealTimers()
  fixture.installs = undefined
  fixture.onScan = undefined
  await rm(fixture.root, { recursive: true, force: true })
})

async function executable(...parts: string[]): Promise<string> {
  const file = join(fixture.root, ...parts)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, '', { mode: 0o755 })
  return file
}

it('migrates saved Orca and bare Claude heads through the same inventory', async () => {
  const orca = await executable('agent-runtimes', 'claude', '1.0', claudeName)
  const user = await executable('.local', 'bin', claudeName)
  fixture.path = dirname(orca)
  for (const head of [quoted(orca), 'claude']) {
    const config = legacy(`${head} --verbose`)
    const cwdPrefix = windows ? '' : "cd -- '/existing cwd' && "
    const result = await alignManagedAgentLaunchAtSpawn(
      {
        launchCommand: `${cwdPrefix}${head} --verbose --resume session`,
        launchConfig: config,
        launchAgent: 'claude',
        restoring: true
      },
      shell
    )
    expect(result).toEqual({
      command: `${cwdPrefix}${quoted(user)} --verbose --resume session`,
      launchConfig: {
        ...config,
        agentCommand: head === 'claude' || !windows ? 'claude --verbose' : '& claude --verbose',
        commandProvenance: 'generated',
        selectedExecutable: user
      }
    })
  }
  expect(fixture.enumerate).toHaveBeenCalledTimes(1)
})

it('keeps a cold scan alive through launch timeouts and publishes the result for retries', async () => {
  const orca = await executable('agent-runtimes', 'claude', '1.0', claudeName)
  const user = await executable('.local', 'bin', claudeName)
  fixture.path = dirname(orca)
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  fixture.onScan = entered.resolve
  fixture.installs = gate.promise
  const inventory = detectInstalledAgentInventory()
  const saved = legacy(`${quoted(orca)} --verbose`)
  const generated = { ...legacy('claude'), commandProvenance: 'generated' as const }
  vi.useFakeTimers()
  const resume = alignManagedAgentLaunchAtSpawn(
    {
      launchCommand: `${saved.agentCommand} --resume session`,
      restoring: true,
      launchConfig: saved
    },
    shell
  )
  const launch = () =>
    alignManagedAgentLaunchAtSpawn(
      {
        launchCommand: 'claude --verbose',
        launchAgent: 'claude',
        launchConfig: generated
      },
      shell
    )
  const fresh = launch()
  try {
    await entered.promise
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await resume).toEqual({ command: undefined, launchConfig: saved, blocked: 'unknown' })
    expect(await fresh).toEqual({ command: undefined, launchConfig: generated, blocked: 'unknown' })
    const retry = launch()
    gate.resolve()
    expect((await inventory).agents).toContain('claude')
    expect((await retry).command).toBe(`${quoted(user)} --verbose`)
    expect((await launch()).command).toBe(`${quoted(user)} --verbose`)
    expect(fixture.enumerate).toHaveBeenCalledTimes(1)
  } finally {
    gate.resolve()
    await inventory
  }
})

it('joins cold detection and selects the installer path for a generated launch', async () => {
  const user = await executable('.local', 'bin', claudeName)
  const gate = Promise.withResolvers<void>()
  fixture.installs = gate.promise
  const inventory = detectInstalledAgentInventory()
  const launch = alignManagedAgentLaunchAtSpawn(
    {
      launchCommand: 'claude --verbose',
      launchAgent: 'claude',
      launchConfig: { ...legacy('claude'), commandProvenance: 'generated' }
    },
    shell
  )
  gate.resolve()
  await inventory
  expect(await launch).toMatchObject({
    command: `${quoted(user)} --verbose`,
    launchConfig: { commandProvenance: 'generated', selectedExecutable: user }
  })
  expect(fixture.enumerate).toHaveBeenCalledTimes(1)
})

it('reports unavailable when only the Orca executable is on PATH', async () => {
  const orca = await executable('agent-runtimes', 'claude', '1.0', claudeName)
  fixture.path = dirname(orca)
  expect((await detectInstalledAgentInventory()).agents).not.toContain('claude')
  expect(
    await alignManagedAgentLaunchAtSpawn(
      {
        launchCommand: 'claude',
        launchAgent: 'claude',
        launchConfig: { ...legacy('claude'), commandProvenance: 'generated' }
      },
      shell
    )
  ).toMatchObject({ command: undefined, blocked: 'unavailable' })
})

it.runIf(windows)('rechecks the cmd launch folder after an earlier miss', async () => {
  const user = await executable('path', 'claude.exe')
  const cwd = join(fixture.root, 'workspace')
  await mkdir(cwd)
  const launch = () =>
    alignManagedAgentLaunchAtSpawn(
      {
        launchCommand: 'claude --verbose',
        launchAgent: 'claude',
        launchConfig: { ...legacy('claude'), commandProvenance: 'generated' },
        cwd
      },
      'cmd'
    )
  const byName = await launch()
  expect(byName.command).toBe('claude --verbose')
  expect(byName.launchConfig?.selectedExecutable).toBeUndefined()
  await executable('workspace', 'claude.cmd')
  expect((await launch()).command).toBe(`"${user}" --verbose`)
})

it('uses one inventory lookup for direct user sign-in and leaves prepared shell text alone', async () => {
  const grok = await executable('.local', 'bin', windows ? 'grok.exe' : 'grok')
  const result = await alignManagedAgentLaunchAtSpawn(
    {
      launchCommand: 'grok login',
      nativeChatSignIn: { agent: 'grok', account: 'system', remote: false }
    },
    shell
  )
  expect(result.command).toBe(windows ? `& '${grok}' 'login'` : `'${grok}' 'login'`)
  expect(await alignManagedAgentLaunchAtSpawn({ launchCommand: result.command }, shell)).toEqual(
    result
  )
  expect(fixture.enumerate).toHaveBeenCalledTimes(1)
})

it('keeps local install selection after a WSL inventory refresh', async () => {
  const user = await executable('.local', 'bin', claudeName)
  await detectInstalledAgentInventory()
  const target = { distro: 'TestUbuntu' }
  invalidateWslGuestEnvironment(target.distro)
  fixture.wslProcess.mockResolvedValueOnce({
    code: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    environmentResolved: true
  })
  await expect(readWslTerminalAgentProgram(target, 'claude')).resolves.toEqual({
    kind: 'unavailable'
  })
  await refreshAgentsOnHost({ kind: 'local', context: { wslDefault: true } }, undefined, true)
  await expect(readWslTerminalAgentProgram(target, 'claude')).resolves.toEqual({
    kind: 'by-name',
    path: 'claude'
  })
  expect(fixture.wslProcess).toHaveBeenCalledTimes(2)
  // The existing local snapshot, rather than a new scan, answers this later generated launch.
  const result = await alignManagedAgentLaunchAtSpawn(
    {
      launchCommand: 'claude',
      launchAgent: 'claude',
      launchConfig: { ...legacy('claude'), commandProvenance: 'generated' }
    },
    shell
  )
  expect(result.command).toBe(quoted(user))
  expect(fixture.enumerate).toHaveBeenCalledTimes(1)
})

it('shares guest inventory until that distro is invalidated', async () => {
  const target = { distro: 'TestUbuntu' }
  invalidateWslGuestEnvironment(target.distro)
  await expect(
    Promise.all([
      readWslTerminalAgentProgram(target, 'claude'),
      readWslTerminalAgentProgram(target, 'codex')
    ])
  ).resolves.toEqual([{ kind: 'by-name', path: 'claude' }, { kind: 'unavailable' }])
  await readWslTerminalAgentProgram(target, 'claude')
  expect(fixture.wslProcess).toHaveBeenCalledTimes(1)
  invalidateWslGuestEnvironment(target.distro)
  await readWslTerminalAgentProgram(target, 'claude')
  expect(fixture.wslProcess).toHaveBeenCalledTimes(2)
  fixture.wslProcess.mockResolvedValueOnce({
    code: 0,
    stdout: '__ORCA_AGENT_PATH__codex\t/opt/tools/bin/codex\n',
    stderr: '',
    timedOut: false,
    environmentResolved: true
  })
  await expect(
    detectAgentCommandsOnHost(['codex'], { context: { wslDistro: target.distro } })
  ).resolves.toEqual(new Set(['codex']))
  await expect(readWslTerminalAgentProgram(target, 'codex')).resolves.toEqual({
    kind: 'by-name',
    path: 'codex'
  })
  expect(fixture.wslProcess).toHaveBeenCalledTimes(3)
})

it('returns the queued refresh result to the cold waiter and overlapping refreshes', async () => {
  const entered = Promise.withResolvers<void>()
  const held = Promise.withResolvers<void>()
  fixture.onScan = entered.resolve
  fixture.installs = held.promise
  const launch = readLocalTerminalAgentProgram('claude', shell)
  try {
    await entered.promise
    const user = await executable('path', claudeName)
    const refresh = () => detectAgentCommandsOnHost(['claude'], { refresh: true })
    const revalidate = readLocalTerminalAgentProgram('claude', shell, true)
    const first = refresh()
    const second = refresh()
    held.resolve()
    await expect(Promise.all([launch, revalidate, first, second])).resolves.toEqual([
      { kind: 'by-name', path: user },
      { kind: 'by-name', path: user },
      new Set(['claude']),
      new Set(['claude'])
    ])
    expect(fixture.enumerate).toHaveBeenCalledTimes(2)
  } finally {
    held.resolve()
    await launch
  }
})

it('retries after an incomplete WSL probe whose fallback exited zero', async () => {
  const target = { distro: 'SlowUbuntu' }
  fixture.wslProcess.mockResolvedValueOnce({
    code: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    environmentResolved: false
  })
  await expect(readWslTerminalAgentProgram(target, 'claude')).resolves.toEqual({ kind: 'unknown' })
  await expect(readWslTerminalAgentProgram(target, 'claude')).resolves.toEqual({
    kind: 'by-name',
    path: 'claude'
  })
  expect(fixture.wslProcess).toHaveBeenCalledTimes(2)
})

it.skipIf(windows)('expands the executable head for standalone Agent Teams', async () => {
  await expect(resolveClaudeTeamsInvocation('~/bin/claude --verbose')).resolves.toEqual({
    command: join(fixture.root, 'bin', 'claude'),
    args: ['--verbose']
  })
  await expect(resolveClaudeTeamsInvocation('claude $FLAGS')).rejects.toThrow('requires a shell')
})

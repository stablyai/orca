import { savedLaunchProgramHead } from '../../../../../shared/agent-launch/startup/managed-agent-launch-program'
import type * as PreflightRuntimeTarget from '../../../../ipc/preflight/preflight-runtime-target'
import type * as InstallerDetection from '../../../../../shared/agent-launch/installation/local-agent-install-dir-detection'
import type * as NodeOs from 'node:os'
import type * as AppEnvironment from '../../../../../shared/app-lifecycle/app-environment'
import type * as LoginShellEnvironment from '../../../../startup/shell-environment/login-shell-environment'
import type * as WslDefaultDistro from '../../../../wsl/discovery/wsl-default-distro'
import type * as WslRunner from '../../../../wsl/execution/wsl-runner'
import type { SleepingAgentLaunchConfig } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { alignManagedAgentLaunchAtSpawn } from '../../../../managed-agent-cli/managed-agent-spawn-program'
import { createWorktreeWithStartupAgent } from '../../../../agent-launch/startup-agent-worktree-create'
import {
  detectInstalledAgentInventory,
  detectInstalledAgents
} from '../../../../preflight/installed-agent-detection'
import {
  AgentInventoryDeadlineError,
  detectAgentCommandsOnHost,
  readLocalTerminalAgentProgram,
  readWslTerminalAgentProgram,
  selectTerminalAgentProgram
} from '../../../../preflight/agent-command-detection'
import { invalidateWslGuestEnvironment } from '../../../../wsl/execution/wsl-guest-environment'
import {
  detectAgentInventoryOnHost,
  detectAgentsOnHost,
  detectProjectLaunchContext,
  HOST_DEFAULT_AGENT_DETECTION,
  refreshAgentsOnHost
} from '../../../../preflight/workspace-agent-detection'
import { resolveClaudeTeamsInvocation } from '../../../terminal/launch/claude-teams-invocation'
import { partialRuntimeStore } from '../../../construction/test-context/runtime-store-partial-fixture'
import { resolveAgentTerminalCreateOptions } from '../../../terminal/launch/runtime-agent-terminal-startup'
import { resolveWorktreeStartupDraftAgent } from '../../../workspaces/startup/runtime-worktree-agent-startup'

const fixture = vi.hoisted(() => {
  const pending: { installs?: Promise<void>; onScan?: () => void } = {}
  return Object.assign(pending, {
    root: '',
    path: '',
    enumerate: vi.fn(() => []),
    wslProcess: vi.fn(async (): Promise<WslRunner.WslResult> => ({
      code: 0,
      stdout: '__ORCA_AGENT_PATH__claude\t/opt/tools/bin/claude\t/opt/tools/bin/claude\n',
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
  buildLocalPreflightEnv: () => ({ PATH: fixture.path, PATHEXT: '.EXE;.CMD' }),
  buildLocalPreflightEnvAsync: async () => ({ PATH: fixture.path, PATHEXT: '.EXE;.CMD' })
}))
vi.mock('../../../../startup/shell-environment/login-shell-environment', async (original) => ({
  ...(await original<typeof LoginShellEnvironment>()),
  captureLoginShellEnvironment: async () => ({ status: 'captured', env: { PATH: fixture.path } })
}))
vi.mock('../../../../ipc/command-path/command-path-directory-worker-client', async () => {
  const directory = await import('../../../../ipc/command-path/command-path-directory')
  return {
    readDetectionDirectoryViaWorker: directory.readDetectionDirectory,
    readInstallDirectoriesViaWorker: directory.readInstallSubdirectories
  }
})
vi.mock('../../../../ipc/command-path/agent-detection-shell-path', () => ({
  hydrateShellPathForAgentDetection: async () => {}
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
const legacy = (agentCommand: string) =>
  ({
    agentCommand,
    agentArgs: '--verbose',
    agentEnv: {}
  }) satisfies SleepingAgentLaunchConfig

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

it.each([
  {
    installed: 'qoder',
    saved: 'qodercli --verbose',
    command: 'qodercli --verbose',
    restoring: false,
    expected: 'qoder --verbose',
    recipe: 'qoder --verbose'
  },
  {
    installed: 'qodercli',
    saved: 'qoder --verbose',
    command: 'qoder --verbose --resume session',
    restoring: true,
    expected: 'qodercli --verbose --resume session',
    recipe: 'qodercli --verbose'
  }
])('launches and records $installed when it is the only Qoder spelling installed', async (test) => {
  await executable('path', windows ? `${test.installed}.exe` : test.installed)
  await expect(
    alignManagedAgentLaunchAtSpawn(
      {
        launchAgent: 'qoder',
        launchCommand: test.command,
        launchConfig: { ...legacy(test.saved), commandProvenance: 'generated' },
        restoring: test.restoring
      },
      shell
    )
  ).resolves.toEqual({
    command: test.expected,
    launchConfig: { ...legacy(test.recipe), commandProvenance: 'generated' }
  })
  await detectAgentCommandsOnHost(['qoder', 'qodercli'], { afterPublication: 0 })
  expect(fixture.enumerate).toHaveBeenCalledTimes(1)
})

it('opens a usable shell after one Qoder inventory deadline from terminal create', async () => {
  const entered = Promise.withResolvers<void>()
  const held = Promise.withResolvers<void>()
  fixture.onScan = entered.resolve
  fixture.installs = held.promise
  vi.useFakeTimers()
  const launchConfig: SleepingAgentLaunchConfig = {
    ...legacy('qodercli --verbose'),
    commandProvenance: 'generated'
  }
  const launch = resolveAgentTerminalCreateOptions(
    { id: 'workspace', path: fixture.root, connectionId: null, repo: null, folderWorkspace: null },
    {
      command: 'qodercli --verbose',
      launchAgent: 'qoder',
      launchConfig,
      launchRuntime: {
        platform: process.platform,
        pty: { shellOverride: undefined, terminalWindowsWslDistro: null }
      }
    },
    { store: partialRuntimeStore(), hostIdentity: 'test', toSessionOptions: () => undefined }
  ).then((options) =>
    alignManagedAgentLaunchAtSpawn(
      {
        launchCommand: options.command,
        launchAgent: options.launchAgent,
        launchConfig: options.launchConfig
      },
      shell
    )
  )
  try {
    await entered.promise
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await Promise.race([launch, Promise.resolve('pending')])).toEqual({
      command: undefined,
      launchConfig,
      blocked: 'unknown'
    })
  } finally {
    const completion = detectAgentCommandsOnHost(['qodercli'], { waitForCompletion: true })
    held.resolve()
    await Promise.all([completion, launch])
  }
})

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
        agentCommand: `${savedLaunchProgramHead(user, shell, ' --verbose')} --verbose`,
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
  vi.useFakeTimers()
  const inventory = detectInstalledAgentInventory().catch((error: unknown) => error)
  const saved = legacy(`${quoted(orca)} --verbose`)
  const generated = { ...legacy('claude'), commandProvenance: 'generated' as const }
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
    expect(await inventory).toMatchObject({ agents: [], incomplete: true })
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
  await expect(
    alignManagedAgentLaunchAtSpawn(
      {
        launchCommand: 'claude',
        launchAgent: 'claude',
        launchConfig: { ...legacy('claude'), commandProvenance: 'generated' },
        setupGate: true
      },
      shell
    )
  ).resolves.toMatchObject({ postSetupProgram: { blocked: true } })
})

it.runIf(windows)('rechecks the cmd launch folder after an earlier miss', async () => {
  const user = await executable('path', 'claude.eXe')
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
    stdout: '__ORCA_AGENT_PATH__codex\t/opt/tools/bin/codex\t/opt/tools/bin/codex\n',
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

it('launches from each scan while unrelated installer reads are still pending', async () => {
  const user = await executable('path', claudeName)
  const replacement = await executable('new-path', claudeName)
  const entered = Promise.withResolvers<void>()
  const held = Promise.withResolvers<void>()
  const successorEntered = Promise.withResolvers<void>()
  const successorHeld = Promise.withResolvers<void>()
  fixture.onScan = entered.resolve
  fixture.installs = held.promise
  const early = readLocalTerminalAgentProgram('claude', shell)
  try {
    await entered.promise
    await expect(early).resolves.toEqual({ kind: 'by-name', path: user })
    fixture.path = dirname(replacement)
    fixture.onScan = successorEntered.resolve
    fixture.installs = successorHeld.promise
    const refresh = detectAgentCommandsOnHost(['claude'], { refresh: true })
    held.resolve()
    await successorEntered.promise
    await expect(readLocalTerminalAgentProgram('claude', shell)).resolves.toEqual({
      kind: 'by-name',
      path: replacement
    })
    successorHeld.resolve()
    await expect(refresh).resolves.toEqual(new Set(['claude']))
    await expect(readLocalTerminalAgentProgram('claude', shell)).resolves.toEqual({
      kind: 'full-path',
      path: replacement
    })
    expect(fixture.enumerate).toHaveBeenCalledTimes(2)
  } finally {
    held.resolve()
    successorHeld.resolve()
    await early
  }
})

it('lets two pickers reuse a completed inventory after their cold deadlines', async () => {
  await executable('path', claudeName)
  const entered = Promise.withResolvers<void>()
  const held = Promise.withResolvers<void>()
  fixture.onScan = entered.resolve
  fixture.installs = held.promise
  vi.useFakeTimers()
  const detectForPicker = (afterPublication?: number) =>
    detectAgentInventoryOnHost(HOST_DEFAULT_AGENT_DETECTION, { afterPublication })
  const detections = Promise.all([detectForPicker(), detectForPicker()])
  try {
    await entered.promise
    await readLocalTerminalAgentProgram('claude', shell)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(detections).resolves.toMatchObject([
      { agents: ['claude'], incomplete: true, afterPublication: 0 },
      { agents: ['claude'], incomplete: true, afterPublication: 0 }
    ])
  } finally {
    const completion = detectAgentsOnHost(HOST_DEFAULT_AGENT_DETECTION)
    held.resolve()
    await completion
  }
  for (const reply of await detections) {
    const retry = await detectForPicker(reply.afterPublication)
    expect(retry.agents).toEqual(['claude'])
    expect(retry.incomplete).toBeUndefined()
    expect(fixture.enumerate).toHaveBeenCalledTimes(1)
  }
  await detectForPicker()
  expect(fixture.enumerate).toHaveBeenCalledTimes(2)
})

it('returns the published agents as incomplete when a detect wait expires', async () => {
  await executable('path', claudeName)
  await detectInstalledAgentInventory()
  const entered = Promise.withResolvers<void>()
  const held = Promise.withResolvers<void>()
  fixture.onScan = entered.resolve
  fixture.installs = held.promise
  vi.useFakeTimers()
  const detect = detectInstalledAgentInventory().catch((error: unknown) => error)
  const plainLists = Promise.allSettled([
    detectInstalledAgents(undefined, { waitForCompletion: false }),
    detectAgentsOnHost(HOST_DEFAULT_AGENT_DETECTION, { waitForCompletion: false })
  ])
  const completeList = detectAgentsOnHost(HOST_DEFAULT_AGENT_DETECTION).catch(
    (error: unknown) => error
  )
  try {
    await entered.promise
    await readLocalTerminalAgentProgram('claude', shell)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await detect).toMatchObject({
      agents: ['claude'],
      incomplete: true,
      afterPublication: 1
    })
    const incompleteList = {
      status: 'rejected',
      reason: expect.objectContaining({
        message: 'Agent inventory is still running. Try again.',
        data: { afterPublication: 1 }
      })
    }
    expect(await plainLists).toEqual([incompleteList, incompleteList])
    expect(await Promise.race([completeList, Promise.resolve('pending')])).toBe('pending')
  } finally {
    held.resolve()
    await completeList
  }
  expect(await completeList).toEqual(['claude'])
  expect(fixture.enumerate).toHaveBeenCalledTimes(2)
})

it('allows workspace creation to retry its draft after an inventory timeout', async () => {
  await executable('path', claudeName)
  const entered = Promise.withResolvers<void>()
  const held = Promise.withResolvers<void>()
  fixture.onScan = entered.resolve
  fixture.installs = held.promise
  vi.useFakeTimers()
  const repo = { id: 'repo', path: fixture.root, displayName: 'Repo', badgeColor: '', addedAt: 0 }
  const store = partialRuntimeStore()
  type CreateRuntime = Parameters<typeof createWorktreeWithStartupAgent>[0]
  const reachedCreate = new Error('Reached workspace creation')
  const runtime: CreateRuntime = {
    showRepo: async () => repo,
    resolveStartupDraftAgent: (resolvedRepo, requestedAgent, afterPublication) =>
      resolveWorktreeStartupDraftAgent({
        repo: resolvedRepo,
        settings: store.getSettings(),
        requestedAgent,
        afterPublication
      }),
    createManagedWorktree: vi
      .fn<CreateRuntime['createManagedWorktree']>()
      .mockRejectedValue(reachedCreate),
    requireStore: () => store,
    getStructuredAgentSessionCreateSupport:
      vi.fn<CreateRuntime['getStructuredAgentSessionCreateSupport']>()
  }
  const args = {
    repoSelector: 'repo',
    name: 'draft-workspace',
    startupDraft: 'Review these changes'
  }
  const first = createWorktreeWithStartupAgent(runtime, args).catch((error: unknown) => error)
  const afterPublication = 0
  try {
    await entered.promise
    await vi.advanceTimersByTimeAsync(10_000)
    const refusal = await first
    expect(refusal).toBeInstanceOf(AgentInventoryDeadlineError)
    expect(refusal).toHaveProperty('message', 'Agent inventory is still running. Try again.')
    expect(refusal).toHaveProperty('data', { afterPublication })
    expect(runtime.createManagedWorktree).not.toHaveBeenCalled()
  } finally {
    const completion = detectAgentCommandsOnHost(['claude'], {
      afterPublication,
      waitForCompletion: true
    })
    held.resolve()
    await completion
  }
  await expect(createWorktreeWithStartupAgent(runtime, { ...args, afterPublication })).rejects.toBe(
    reachedCreate
  )
  expect(fixture.enumerate).toHaveBeenCalledTimes(1)
  expect(runtime.createManagedWorktree).toHaveBeenCalledExactlyOnceWith({
    repoSelector: 'repo',
    name: 'draft-workspace',
    startupDraft: 'Review these changes',
    startupDraftAgent: 'claude'
  })
})

it('uses WSL fallback hits and retries inconclusive misses after cooldown', async () => {
  vi.useFakeTimers()
  const target = { distro: 'SlowUbuntu' }
  fixture.wslProcess.mockResolvedValueOnce({
    code: 0,
    stdout: '__ORCA_AGENT_PATH__codex\t/opt/tools/bin/codex\t/opt/tools/bin/codex\n',
    stderr: '',
    timedOut: false,
    environmentResolved: false
  })
  await expect(readWslTerminalAgentProgram(target, 'claude')).resolves.toEqual({ kind: 'unknown' })
  await expect(readWslTerminalAgentProgram(target, 'codex')).resolves.toEqual({
    kind: 'by-name',
    path: 'codex'
  })
  await expect(readWslTerminalAgentProgram(target, 'claude')).resolves.toEqual({ kind: 'unknown' })
  expect(fixture.wslProcess).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(5_000)
  await expect(readWslTerminalAgentProgram(target, 'claude')).resolves.toEqual({
    kind: 'by-name',
    path: 'claude'
  })
  expect(fixture.wslProcess).toHaveBeenCalledTimes(2)
})

it('selects and reuses a confirmed WSL Qoder alias with an unverified preferred spelling', async () => {
  vi.useFakeTimers()
  fixture.wslProcess.mockResolvedValueOnce({
    code: 0,
    stdout: '__ORCA_AGENT_PATH__qoder\t/opt/qoder/bin/qoder\t/opt/qoder/bin/qoder\n',
    stderr: '',
    timedOut: false,
    environmentResolved: false
  })
  const select = () =>
    selectTerminalAgentProgram(['qodercli', 'qoder'], 'posix', {
      wsl: { distro: 'QoderAliasUbuntu' }
    })
  const expected = { program: 'qoder', result: { kind: 'by-name', path: 'qoder' } }
  await expect(select()).resolves.toEqual(expected)
  await vi.advanceTimersByTimeAsync(5_001)
  await expect(select()).resolves.toEqual(expected)
  expect(fixture.wslProcess).toHaveBeenCalledTimes(1)
})

it('coalesces refreshes requested during an active WSL refresh into one successor', async () => {
  const entered = Promise.withResolvers<void>()
  const held = Promise.withResolvers<WslRunner.WslResult>()
  fixture.wslProcess.mockImplementationOnce(() => {
    entered.resolve()
    return held.promise
  })
  const refresh = () =>
    detectAgentCommandsOnHost(['claude'], {
      context: { wslDistro: 'RefreshUbuntu' },
      refresh: true
    })
  const first = refresh()
  try {
    await entered.promise
    const second = refresh()
    const third = refresh()
    held.resolve({ code: 0, stdout: '', stderr: '', timedOut: false, environmentResolved: true })
    await expect(Promise.all([first, second, third])).resolves.toEqual([
      new Set(),
      new Set(['claude']),
      new Set(['claude'])
    ])
    expect(fixture.wslProcess).toHaveBeenCalledTimes(2)
  } finally {
    held.resolve({ code: 0, stdout: '', stderr: '', timedOut: false, environmentResolved: true })
    await first
  }
})

it('keeps an SSH worker agent miss even when Claude is installed locally', async () => {
  await executable('path', claudeName)
  const context = await detectProjectLaunchContext(
    {},
    {
      id: 'remote-repo',
      path: '/work/repo',
      displayName: 'Remote repo',
      badgeColor: '',
      addedAt: 0,
      connectionId: 'remote-host'
    },
    'claude',
    { detect: async (host) => (host.kind === 'ssh' ? [] : ['claude']) }
  )
  expect(context).toEqual({
    agents: [],
    workspaceKind: 'git-worktree',
    executionContext: { kind: 'ssh' }
  })
})

it.skipIf(windows)('expands the executable head for standalone Agent Teams', async () => {
  await expect(resolveClaudeTeamsInvocation('~/bin/claude --verbose')).resolves.toEqual({
    command: join(fixture.root, 'bin', 'claude'),
    args: ['--verbose']
  })
  await expect(resolveClaudeTeamsInvocation('claude $FLAGS')).rejects.toThrow('requires a shell')
})

it('uses the caller PATH for standalone Agent Teams even with a verified host install', async () => {
  const hostClaude = await executable('host-bin', claudeName)
  const callerClaude = await executable('caller-bin', claudeName)
  fixture.path = dirname(hostClaude)
  await expect(resolveClaudeTeamsInvocation(undefined)).resolves.toEqual({ command: hostClaude })
  await expect(
    resolveClaudeTeamsInvocation(undefined, {
      env: { PATH: dirname(callerClaude), PATHEXT: '.exe' }
    })
  ).resolves.toEqual({ command: callerClaude })
  await expect(resolveClaudeTeamsInvocation(undefined, { env: { PATH: '' } })).rejects.toThrow(
    'Your Claude installation could not be found.'
  )
})

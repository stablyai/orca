import * as spawnRouting from './pty/host-env/fresh-spawn-routing'
import * as teamsShim from '../runtime/claude-agent-teams-shim-env'
import { WorktreeTerminalMutationLock } from '../runtime/worktree-terminal-mutation-lock'
import * as teamsPlan from '../runtime/terminal/launch/agent-teams-launch-plan'
import { SessionNotFoundError } from '../daemon/daemon-errors'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { classifyErrorMock, statSyncMock, trackMock } from './pty-ipc-mock-registry'
import {
  providerFacts,
  recordOf,
  restoreMainPlatform,
  setMainPlatform,
  startParityLanes,
  type ParityLanes,
  spawnBoth
} from './pty-launch-parity.test-fixture'
import {
  POSIX_PATH,
  WIN_PATH,
  WINDOW_LAUNCH_CASES,
  WSL_PATH
} from '../../shared/launch-parity-window-cases.test-fixture'
import { PLUS_LAUNCH_CASES } from '../../shared/launch-parity-plus-cases.test-fixture'
import { WORKSPACE_START_LAUNCH_CASES } from '../../shared/launch-parity-workspace-start-cases.test-fixture'
import {
  expectedWindowProvider,
  launchWorkspaceId,
  windowSpawnRequest,
  type LaunchWorkspace,
  type WindowProviderFacts
} from '../../shared/launch-parity-window-request.test-fixture'
import {
  AUTOMATION_LAUNCH_CASES,
  automationSpawnRequest
} from '../../shared/launch-parity-automation-cases.test-fixture'
import {
  expectedHostProvider,
  HOST_LAUNCH_CASES,
  HOST_LEAF_ID,
  HOST_TAB_ID,
  type HostLaunchCase
} from './pty-launch-parity-host.test-cases'
import { isHiddenRendererPty } from './pty-hidden-delivery-gate'
import { ptySizes } from './pty/delivery/visibility-state'
import { agentSessionOwners } from './pty/pane/agent-session-owners'
import {
  makePaneSpawnReservationKey,
  paneSpawnReservationsByOwnerKey
} from './pty/pane/spawn-reservation'
import { makePaneKey } from '../../shared/stable-pane-id'
import { CALLER_LAUNCH_CASES, OPENCODE_MODEL } from './pty-launch-parity-caller.test-cases'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { DESKTOP_RPC_CALLER } from '../runtime/rpc/rpc-caller-identity'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from './desktop-renderer-runtime-capabilities'
import { TERMINAL_LIFECYCLE_METHODS } from '../runtime/rpc/methods/terminal/terminal-lifecycle-methods'
import { AGENT_SESSION_METHODS } from '../runtime/rpc/methods/agent-session'
import { applyManagedDataAccountEnvironment } from '../managed-data-accounts/launch-environment'
import { probeOpenCodeLaunchCapabilities } from '../opencode/opencode-launch-capabilities'
import {
  probeOpenCodeModelAvailability,
  resolveOpenCodeDirectModelExecutable
} from '../opencode/opencode-model-availability'
import { probeOpenCodeLaunchModelContext } from '../opencode/opencode-launch-model-context'
import { readOpenSshDefaultShell } from '../../shared/openssh-default-shell'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).fsPromisesModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
// Model an OpenCode v2 install with the selected model without running its binary.
vi.mock('../managed-data-accounts/launch-environment', () => ({
  applyManagedDataAccountEnvironment: vi.fn()
}))
vi.mock('../opencode/opencode-launch-capabilities', () => ({
  probeOpenCodeLaunchCapabilities: vi.fn()
}))
vi.mock('../opencode/opencode-model-availability', () => ({
  resolveOpenCodeDirectModelExecutable: vi.fn(),
  probeOpenCodeModelAvailability: vi.fn()
}))
vi.mock('../opencode/opencode-launch-model-context', () => ({
  probeOpenCodeLaunchModelContext: vi.fn()
}))
// Every fixture folder exists on its execution host.
vi.mock('../project-groups/folder-workspace-path-status', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFolderWorkspacePathStatus: vi.fn(async () => ({ path: '', exists: true }))
}))
// No selected Antigravity account means launch preparation requires no account switch.
vi.mock('../antigravity/native-account-launch', () => ({
  prepareAntigravityAccountForLaunch: vi.fn(async () => {})
}))
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)
// Only managed Windows SSH-host cases supply OpenSSH DefaultShell.
vi.mock('../../shared/openssh-default-shell', () => ({ readOpenSshDefaultShell: vi.fn(() => '') }))

type WindowLaneCase = {
  label: string
  client: NodeJS.Platform
  workspace: LaunchWorkspace
  settings?: Record<string, unknown>
  request: Record<string, unknown>
  provider: WindowProviderFacts
  env: Record<string, string>
}

const WINDOW_LANE_CASES: WindowLaneCase[] = [
  ...[...WINDOW_LAUNCH_CASES, ...PLUS_LAUNCH_CASES, ...WORKSPACE_START_LAUNCH_CASES].map((c) => ({
    ...c,
    label: `row ${c.row}: ${c.name}`,
    request: windowSpawnRequest(c),
    env: c.request.agentEnv ?? {}
  })),
  ...AUTOMATION_LAUNCH_CASES.map((c) => ({
    ...c,
    label: `row 5: ${c.name}`,
    request: automationSpawnRequest(c),
    env: {}
  }))
]

// Exercise real window-lane spawning through provider, telemetry and pane binding.
describe('window lane: pty:spawn request -> provider', () => {
  const suite = setupPtyIpcSuite()
  afterEach(() => restoreMainPlatform())

  it.each(WINDOW_LANE_CASES)(
    '$label',
    async ({ client, workspace, settings, request, provider, env: agentEnv }) => {
      // A desktop client's main process runs on the client OS.
      setMainPlatform(client)
      const lanes = startParityLanes(suite, { workspace, settings })
      await lanes.spawnWindow(request)

      expect(await providerFacts(lanes.provider)).toEqual(
        expectedWindowProvider(request, provider, agentEnv)
      )
      expect(trackMock.mock.calls).toEqual([['agent_started', request.telemetry]])
      expect(lanes.persistPtyBinding.mock.calls).toEqual([
        [
          {
            worktreeId: request.worktreeId,
            tabId: request.tabId,
            leafId: request.leafId,
            ptyId: expect.any(String),
            startupCwd: expect.any(String),
            ...pick(request, ['placement']),
            origin: 'spawn'
          }
        ]
      ])
    }
  )
})

function pick(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]))
}

function stubOpenCodeV2(): void {
  vi.mocked(applyManagedDataAccountEnvironment).mockReset()
  vi.mocked(resolveOpenCodeDirectModelExecutable).mockReset().mockResolvedValue('/bin/opencode')
  vi.mocked(probeOpenCodeLaunchCapabilities)
    .mockReset()
    .mockResolvedValue({ version: '2.0.16', pluginApi: 'v2', promptMode: 'prefill' })
  vi.mocked(probeOpenCodeModelAvailability).mockReset().mockResolvedValue(true)
  vi.mocked(probeOpenCodeLaunchModelContext)
    .mockReset()
    .mockResolvedValueOnce({
      primaryAgent: 'build',
      availableModels: [OPENCODE_MODEL],
      primaryModel: 'opencode/big-pickle'
    })
    .mockResolvedValue({
      primaryAgent: 'build',
      availableModels: [OPENCODE_MODEL],
      primaryModel: OPENCODE_MODEL
    })
}

async function runHostCall(lanes: ParityLanes, c: HostLaunchCase): Promise<unknown> {
  if (c.call.kind === 'create') {
    return lanes.runtime.createTerminal(`id:${launchWorkspaceId(c.workspace)}`, c.call.options)
  }
  const { method, params } = c.call
  const dispatcher = new RpcDispatcher({
    runtime: lanes.runtime,
    methods: [...TERMINAL_LIFECYCLE_METHODS, ...AGENT_SESSION_METHODS]
  })
  const response = await dispatcher.dispatch(
    {
      id: 'parity',
      // The transport authenticated the caller before dispatch; the dispatcher only carries it.
      authToken: 'token',
      method,
      params:
        method === 'terminal.createAgentSession'
          ? { clientOperationId: `${Date.now()}-0123456789abcdef0123456789abcdef`, ...params }
          : params
    },
    // Row 4 is the desktop's own runtime:call (ipc/runtime.ts); row 7 comes from a paired desktop.
    c.row === '4'
      ? {
          clientId: 'desktop-renderer',
          caller: DESKTOP_RPC_CALLER,
          clientKind: 'runtime',
          connectionId: 'desktop-window-1',
          clientCapabilities: DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES
        }
      : { clientId: 'device-1', pairedDeviceId: 'device-1', clientKind: 'runtime' }
  )
  if (!response.ok) {
    throw Object.assign(new Error(response.error.message), { code: response.error.code })
  }
  return response.result
}

// Exercise host producers through the real runtime controller, including telemetry and phone tabs.
describe('host lane: producer call -> runtime controller -> provider', () => {
  const suite = setupPtyIpcSuite()
  beforeEach(() => stubOpenCodeV2())
  afterEach(() => restoreMainPlatform())

  it.each([...HOST_LAUNCH_CASES, ...CALLER_LAUNCH_CASES])('row $row: $name', async (c) => {
    setMainPlatform(c.os)
    const lanes = startParityLanes(suite, { workspace: c.workspace, settings: c.settings })
    await runHostCall(lanes, c)

    expect(await providerFacts(lanes.provider)).toEqual(expectedHostProvider(c))
    // The host stamps its own pane identity (the window lane's stale-key case is below).
    const spawned = recordOf(lanes.provider.mock.calls.at(-1)?.[0])
    expect(recordOf(spawned.env).ORCA_PANE_KEY).toBe(spawned.paneKey)
    expect(recordOf(spawned.env).ORCA_WORKSPACE_ID).toBe(launchWorkspaceId(c.workspace))
    expect(trackMock.mock.calls).toEqual(c.telemetry ? [['agent_started', c.telemetry]] : [])
    expect(lanes.persistPtyBinding.mock.calls[0]?.[0]).toMatchObject({
      placement: { kind: 'new-tab' }
    })
    const phone = await lanes.runtime.listMobileSessionTabs(`id:${launchWorkspaceId(c.workspace)}`)
    expect(pick({ ...phone.tabs[0] }, ['title', 'launchAgent', 'isActive'])).toEqual(c.phone)
  })
})

const POSIX_REPO = { kind: 'repo', path: POSIX_PATH } as const
const WORKER = HOST_LAUNCH_CASES.find((c) => c.name.startsWith('orchestration worker'))!

describe('launch facts outside the tables', () => {
  const suite = setupPtyIpcSuite()
  afterEach(() => restoreMainPlatform())

  it.each(['ipc', 'runtime', 'ipc-replay', 'ipc-reentry', 'ipc-reentry-refused'] as const)(
    '%s settles a contested recovery on one owner with balanced preparation resources',
    async (lane) => {
      const workspace =
        lane === 'ipc' || lane === 'runtime'
          ? POSIX_REPO
          : { kind: 'folder' as const, path: POSIX_PATH }
      const lanes = startParityLanes(suite, { workspace })
      const pane = {
        worktreeId: launchWorkspaceId(workspace),
        tabId: HOST_TAB_ID,
        leafId: HOST_LEAF_ID
      }
      if (lane === 'ipc-reentry' || lane === 'ipc-reentry-refused') {
        const refused = lane === 'ipc-reentry-refused'
        classifyErrorMock.mockReturnValue({ error_class: 'unknown' })
        await lanes.store.admitTerminalPane({
          type: 'createTerminalTab',
          workspace: pane.worktreeId,
          ...pane
        })
        const paneKey = makePaneKey(pane.tabId, pane.leafId)
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: exposes the existing selector; empty-inventory Sleep needs only this local workspace identity.
        const selecting = lanes.runtime as unknown as {
          resolveWorktreeSelector: () => Promise<{ id: string }>
        }
        vi.spyOn(selecting, 'resolveWorktreeSelector').mockResolvedValue({ id: pane.worktreeId })
        const events: string[] = []
        const releases: ReturnType<typeof vi.fn<() => void>>[] = []
        const finishes: ReturnType<typeof vi.fn<() => void>>[] = []
        const existingSizes = new Set(ptySizes.keys())
        let firstId: string | undefined
        let queuedSleep: Promise<void> | undefined
        let attempts = 0
        vi.spyOn(teamsShim, 'ensureClaudeAgentTeamsShimDir').mockResolvedValue('/fixture/shim')
        vi.spyOn(teamsShim, 'resolveClaudeAgentTeamsShimBin').mockReturnValue(null)
        const prepareTeam = vi.spyOn(lanes.runtime, 'prepareClaudeAgentTeamsLeaderForHandle')
        const releaseTeam = vi.spyOn(lanes.runtime, 'releaseClaudeAgentTeamsLeaderForHandle')
        const registeredHandle = vi.spyOn(lanes.runtime, 'registerPreAllocatedHandleForPty')
        const beginRegistration = vi.spyOn(lanes.runtime, 'beginPtyRegistration')
        const begin = spawnRouting.beginPtySpawnForWorktree
        const installing = vi
          .spyOn(spawnRouting, 'beginPtySpawnForWorktree')
          .mockImplementation((...a) => {
            const finish = vi.fn(begin(...a))
            finishes.push(finish)
            return finish
          })
        const acquire = WorktreeTerminalMutationLock.prototype.acquire
        vi.spyOn(WorktreeTerminalMutationLock.prototype, 'acquire').mockImplementation(
          async function (this: WorktreeTerminalMutationLock, key, kind, deadline) {
            if (kind !== 'shared') {
              return acquire.call(this, key, kind, deadline)
            }
            const attempt = ++attempts
            if (attempt === 2 && refused) {
              throw new Error('second_preparation_refused')
            }
            const release = await acquire.call(this, key, kind, deadline)
            events.push(`shared-${attempt}`)
            const receipt = vi.fn(() => {
              events.push(`release-${attempt}`)
              release()
            })
            releases.push(receipt)
            if (attempt === 1) {
              firstId = [...ptySizes.keys()].find((id) => !existingSizes.has(id))
              await lanes.store.persistPtyBinding({
                ...pane,
                ptyId: 'winner',
                incarnationId: 'winner-inc'
              })
              queuedSleep = acquire.call(this, key, 'exclusive').then((finishSleep) => {
                events.push('exclusive')
                finishSleep()
              })
              expect(events).toEqual(['shared-1'])
            }
            return receipt
          }
        )
        onTestFinished(async () => {
          for (const release of [...releases, ...finishes]) {
            if (release.mock.calls.length === 0) {
              release()
            }
          }
          await queuedSleep
          vi.restoreAllMocks()
        })
        lanes.provider.mockImplementation(async (args) => {
          if (args.attachOnly) {
            throw new SessionNotFoundError(args.sessionId)
          }
          return { id: 'fresh-reentry', incarnationId: 'fresh-inc' }
        })
        const operation = lanes.spawnWindow({
          ...pane,
          cols: 80,
          rows: 24,
          cwd: POSIX_PATH,
          command: 'claude --teammate-mode auto',
          initiallyHidden: true
        })
        if (refused) {
          await expect(operation).rejects.toThrow('second_preparation_refused')
        } else {
          await expect(operation).resolves.toMatchObject({ id: 'fresh-reentry' })
          expect(
            lanes.runtime.resolveTerminalPane(`${pane.tabId}:${pane.leafId}`, pane.worktreeId)
          ).toMatchObject({ ptyId: 'fresh-reentry', connected: true })
          expect(
            lanes.store.getWorkspaceSession().terminalLayoutsByTabId[pane.tabId]?.ptyIdsByLeafId?.[
              pane.leafId
            ]
          ).toBe('fresh-reentry')
        }
        await queuedSleep
        const handles = prepareTeam.mock.calls.map(([args]) => args.handle)
        expect(new Set(handles).size).toBe(2)
        expect(releaseTeam.mock.calls).toEqual(
          (refused ? handles : handles.slice(0, 1)).map((handle) => [handle])
        )
        expect(registeredHandle.mock.calls).toEqual(
          (refused ? [] : [1, 2]).map(() => ['fresh-reentry', handles[1]])
        )
        expect(releaseTeam.mock.invocationCallOrder[0]).toBeLessThan(
          prepareTeam.mock.invocationCallOrder[1]!
        )
        expect(attempts).toBe(2)
        expect(releases).toHaveLength(refused ? 1 : 2)
        expect(finishes).toHaveLength(2)
        for (const receipt of [...releases, ...finishes]) {
          expect(receipt).toHaveBeenCalledOnce()
        }
        expect(finishes[0]!.mock.invocationCallOrder[0]).toBeLessThan(
          installing.mock.invocationCallOrder[1]!
        )
        expect(events).toEqual(
          refused
            ? ['shared-1', 'release-1', 'exclusive']
            : ['shared-1', 'release-1', 'exclusive', 'shared-2', 'release-2']
        )
        expect(
          lanes.provider.mock.calls.map(([args]) => [args.attachOnly === true, args.command])
        ).toEqual(
          refused
            ? [[true, undefined]]
            : [
                [true, undefined],
                [false, 'claude --teammate-mode auto']
              ]
        )
        expect(firstId).toBeDefined()
        expect(isHiddenRendererPty(firstId!)).toBe(false)
        expect(ptySizes.has(firstId!)).toBe(false)
        expect(beginRegistration.mock.calls.some(([id]) => id === firstId)).toBe(false)
        expect(
          lanes.store.getWorkspaceSession().terminalLayoutsByTabId[pane.tabId]?.root
        ).toMatchObject({ type: 'leaf', leafId: pane.leafId })
        expect(
          paneSpawnReservationsByOwnerKey.has(
            makePaneSpawnReservationKey(pane.worktreeId, null, paneKey)!
          )
        ).toBe(false)
        if (!refused) {
          await lanes.runtime.onPtyExit('fresh-reentry', 0, 'fresh-inc', {
            providerExitObserved: true
          })
        }
        await expect(
          lanes.runtime.sleepTerminalsForWorktree(`id:${pane.worktreeId}`)
        ).resolves.toMatchObject({ stopped: 0, postStopVerified: true })
        return
      }
      // Replay: a stale window save re-adds the binding the host just proved dead before the commit.
      const replay = lane === 'ipc-replay'
      const owner = replay ? 'fresh' : 'winner'
      await lanes.store.persistPtyBinding({ ...pane, ptyId: 'old' })
      lanes.provider.mockImplementation(async (args) => {
        if (!args.attachOnly) {
          await lanes.store.persistPtyBinding({ ...pane, ptyId: 'old' })
          return { id: 'fresh', incarnationId: 'fresh-inc' }
        }
        if (args.sessionId !== 'old') {
          return { id: 'winner', incarnationId: 'winner-inc', isReattach: true }
        }
        if (!replay) {
          await lanes.store.persistPtyBinding({
            ...pane,
            ptyId: 'winner',
            incarnationId: 'winner-inc'
          })
        }
        throw new SessionNotFoundError('old')
      })
      await (lane.startsWith('ipc')
        ? expect(lanes.spawnWindow({ ...pane, cols: 80, rows: 24 })).resolves.toMatchObject({
            id: owner
          })
        : lanes.runtime.createTerminal(`id:${pane.worktreeId}`, {
            tabId: pane.tabId,
            leafId: pane.leafId
          }))
      expect(
        lanes.runtime.resolveTerminalPane(`${pane.tabId}:${pane.leafId}`, pane.worktreeId)
      ).toMatchObject({ ptyId: owner, connected: true })
      expect(lanes.provider.mock.calls.map(([args]) => args.attachOnly === true)).toEqual([
        true,
        !replay
      ])
      expect(
        lanes.store.getWorkspaceSession().terminalLayoutsByTabId[pane.tabId]?.ptyIdsByLeafId?.[
          pane.leafId
        ]
      ).toBe(owner)
    }
  )

  it('does not readmit a recovered pane closed during lazy launch preparation', async () => {
    const lanes = startParityLanes(suite, { workspace: POSIX_REPO })
    const binding = {
      worktreeId: launchWorkspaceId(POSIX_REPO),
      tabId: HOST_TAB_ID,
      leafId: HOST_LEAF_ID,
      ptyId: 'absent-before-preparation'
    }
    await lanes.store.persistPtyBinding(binding)
    lanes.provider.mockRejectedValueOnce(new SessionNotFoundError(binding.ptyId))
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const plan = teamsPlan.buildRuntimeAgentTeamsLaunchPlan
    const preparing = vi
      .spyOn(teamsPlan, 'buildRuntimeAgentTeamsLaunchPlan')
      .mockImplementation(async (args) => {
        await gate
        return plan(args)
      })
    try {
      const created = lanes.runtime.createTerminal(`id:${binding.worktreeId}`, {
        tabId: HOST_TAB_ID,
        leafId: HOST_LEAF_ID
      })
      const refused = expect(created).rejects.toThrow('terminal_pane_owner_changed')
      await vi.waitFor(() => expect(preparing).toHaveBeenCalledOnce())
      await lanes.store.withdrawTerminalPane({
        type: 'closePane',
        workspace: binding.worktreeId,
        tabId: HOST_TAB_ID,
        leafId: HOST_LEAF_ID
      })
      release()
      await refused
      expect(lanes.provider).toHaveBeenCalledOnce()
      expect(lanes.store.getWorkspaceSession().terminalLayoutsByTabId[HOST_TAB_ID]).toBeUndefined()
      expect(lanes.reveal).not.toHaveBeenCalled()
    } finally {
      release()
      preparing.mockRestore()
    }
  })

  it.each([
    {
      lane: 'telemetry kind wins over the claude sniff',
      request: { command: 'claude', telemetry: { agent_kind: 'opencode' } },
      calls: [['agent_error', { agent_kind: 'opencode', error_class: 'binary_not_found' }]]
    },
    {
      lane: 'local claude without telemetry',
      request: { command: 'claude' },
      calls: [['agent_error', { agent_kind: 'claude-code', error_class: 'binary_not_found' }]]
    }
  ])('a failed window spawn, $lane, emits agent_error', async (c) => {
    setMainPlatform('darwin')
    classifyErrorMock.mockReturnValue({ error_class: 'binary_not_found' })
    const spawnError = new Error('spawn boom')
    const lanes = startParityLanes(suite, { workspace: POSIX_REPO, spawnError })
    const launch = lanes.spawnWindow({
      cols: 80,
      rows: 24,
      cwd: POSIX_PATH,
      worktreeId: launchWorkspaceId(POSIX_REPO),
      ...c.request
    })
    await expect(launch).rejects.toThrow('spawn boom')
    expect(trackMock.mock.calls.filter(([event]) => event === 'agent_error')).toEqual(c.calls)
  })

  // Current lane difference: window failures emit agent_error; host failures do not.
  const FAILED_START_AGENT_ERROR: Record<'window' | 'host', unknown[]> = {
    window: [['agent_error', { agent_kind: 'claude-code', error_class: 'binary_not_found' }]],
    host: [['agent_error', { agent_kind: 'claude-code', error_class: 'binary_not_found' }]]
  }
  it.each(['window', 'host'] as const)(
    '%s lane: a start the provider fails undoes everything it claimed',
    async (lane) => {
      setMainPlatform('darwin')
      classifyErrorMock.mockReturnValue({ error_class: 'binary_not_found' })
      const lanes = startParityLanes(suite, { workspace: POSIX_REPO })
      let hiddenWhileSpawning = false
      lanes.provider.mockImplementationOnce(async (options: { sessionId?: string }) => {
        hiddenWhileSpawning = isHiddenRendererPty(String(options.sessionId))
        throw new Error('spawn boom')
      })
      const gateReleased = vi.fn()
      const acquireGate = lanes.runtime.acquireWorktreeTerminalSpawn.bind(lanes.runtime)
      vi.spyOn(lanes.runtime, 'acquireWorktreeTerminalSpawn').mockImplementation(async (...a) => {
        const release = await acquireGate(...a)
        return () => {
          gateReleased()
          release()
        }
      })
      const beginRegistration = vi.spyOn(lanes.runtime, 'beginPtyRegistration')
      const cancelRegistration = vi.spyOn(lanes.runtime, 'cancelPendingPtyRegistration')
      const worktreeId = launchWorkspaceId(POSIX_REPO)
      const launch =
        lane === 'host'
          ? runHostCall(lanes, HOST_LAUNCH_CASES[0]!)
          : lanes.spawnWindow({
              cols: 80,
              rows: 24,
              cwd: POSIX_PATH,
              worktreeId,
              tabId: HOST_TAB_ID,
              leafId: HOST_LEAF_ID,
              command: 'claude',
              initiallyHidden: true,
              telemetry: { agent_kind: 'claude-code', launch_source: 'task_page' }
            })

      await expect(launch).rejects.toThrow('spawn boom')
      const sessionId = String(recordOf(lanes.provider.mock.calls.at(-1)?.[0]).sessionId)
      expect(trackMock.mock.calls).toEqual(FAILED_START_AGENT_ERROR[lane])
      expect(hiddenWhileSpawning).toBe(true)
      expect(isHiddenRendererPty(sessionId)).toBe(false)
      const claim =
        beginRegistration.mock.results[
          beginRegistration.mock.calls.findIndex(([id]) => id === sessionId)
        ]?.value
      expect(claim).toBeDefined()
      expect(cancelRegistration.mock.calls).toEqual([[sessionId, undefined, claim]])
      expect(gateReleased).toHaveBeenCalledOnce()
      expect(ptySizes.has(sessionId)).toBe(false)
      const paneKey = makePaneKey(HOST_TAB_ID, HOST_LEAF_ID)
      expect(
        paneSpawnReservationsByOwnerKey.has(makePaneSpawnReservationKey(worktreeId, null, paneKey)!)
      ).toBe(false)
    }
  )

  it('host lane: concurrent resumes of one Claude session count one failed start once', async () => {
    setMainPlatform('darwin')
    classifyErrorMock.mockReturnValue({ error_class: 'binary_not_found' })
    const lanes = startParityLanes(suite, { workspace: POSIX_REPO })
    lanes.provider.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      throw new Error('spawn boom')
    })
    const resume = {
      kind: 'explicit' as const,
      worktree: `id:${launchWorkspaceId(POSIX_REPO)}`,
      agent: 'claude' as const,
      providerSession: { key: 'session_id' as const, id: '11111111-1111-4111-8111-111111111111' }
    }

    const results = await Promise.allSettled([
      lanes.runtime.ensureAgentSession(resume),
      lanes.runtime.ensureAgentSession(resume)
    ])

    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
    expect(lanes.provider).toHaveBeenCalledOnce()
    expect(trackMock.mock.calls.filter(([event]) => event === 'agent_error')).toEqual([
      ['agent_error', { agent_kind: 'claude-code', error_class: 'binary_not_found' }]
    ])
  })

  it('host lane: a Claude resume its claim refuses counts one failed start', async () => {
    setMainPlatform('darwin')
    classifyErrorMock.mockReturnValue({ error_class: 'unknown' })
    const lanes = startParityLanes(suite, { workspace: POSIX_REPO })
    vi.spyOn(agentSessionOwners, 'ensure').mockRejectedValueOnce(
      new Error('agent_session_conflict')
    )

    await expect(
      lanes.runtime.ensureAgentSession({
        kind: 'explicit',
        worktree: `id:${launchWorkspaceId(POSIX_REPO)}`,
        agent: 'claude',
        providerSession: { key: 'session_id', id: '22222222-2222-4222-8222-222222222222' }
      })
    ).rejects.toThrow('agent_session_conflict')
    expect(lanes.provider).not.toHaveBeenCalled()
    expect(trackMock.mock.calls.filter(([event]) => event === 'agent_error')).toHaveLength(1)
  })

  it('row 10: an orchestration worker requests a titled, inactive reveal', async () => {
    setMainPlatform(WORKER.os)
    const lanes = startParityLanes(suite, { workspace: WORKER.workspace })
    await runHostCall(lanes, WORKER)
    expect(lanes.reveal.mock.calls[0]?.[1]).toMatchObject({
      title: 'worker-task-1',
      activate: false,
      surfaceOwner: false
    })
    expect(lanes.reveal.mock.calls[0]?.[1]).not.toHaveProperty('presentation')
  })

  it('row 7: a paired agent session with no buildable launch refuses before any spawn', async () => {
    setMainPlatform('linux')
    const lanes = startParityLanes(suite, { workspace: POSIX_REPO })
    const aiderDraft: HostLaunchCase = {
      ...WORKER,
      row: '7',
      call: {
        kind: 'rpc',
        method: 'terminal.createAgentSession',
        params: {
          worktree: `id:${launchWorkspaceId(POSIX_REPO)}`,
          agent: 'aider',
          prompt: 'fix it',
          promptDelivery: 'draft'
        }
      }
    }
    await expect(runHostCall(lanes, aiderDraft)).rejects.toMatchObject({
      message: 'agent_session_identity_required'
    })
    expect(lanes.provider).not.toHaveBeenCalled()
  })

  it('window lane: the provider gets the pane keys main derives, not the stale ones sent', async () => {
    setMainPlatform('darwin')
    const tabId = '55555555-5555-4555-8555-555555555555'
    const leafId = '66666666-6666-4666-8666-666666666666'
    const lanes = startParityLanes(suite, { workspace: POSIX_REPO })
    await lanes.spawnWindow({
      cols: 80,
      rows: 24,
      cwd: POSIX_PATH,
      worktreeId: launchWorkspaceId(POSIX_REPO),
      tabId,
      leafId,
      env: { ORCA_WORKSPACE_ID: 'folder:f1', ORCA_PANE_KEY: 'stale', ORCA_TAB_ID: 'stale' }
    })
    const env = recordOf(recordOf(lanes.provider.mock.calls.at(-1)?.[0]).env)
    expect(pick(env, ['ORCA_WORKSPACE_ID', 'ORCA_PANE_KEY', 'ORCA_TAB_ID'])).toEqual({
      ORCA_WORKSPACE_ID: 'folder:f1',
      ORCA_PANE_KEY: `${tabId}:${leafId}`,
      ORCA_TAB_ID: tabId
    })
  })
})

const WSL_UBUNTU = { kind: 'wsl', distro: 'Ubuntu' } as const
const WSL_PROJECT_SENT = {
  status: 'resolved',
  runtime: {
    kind: 'wsl',
    hostPlatform: 'wsl',
    projectId: 'repo-1',
    distro: 'Ubuntu',
    reason: 'project-override',
    cacheKey: 'repo-1:wsl:Ubuntu'
  }
}
const LOGIN_SHELL = String.raw`C:\Program Files\PowerShell\7\pwsh.exe`

describe('spawn preflight: where the lanes differ today', () => {
  const suite = setupPtyIpcSuite()
  afterEach(() => {
    restoreMainPlatform()
    vi.unstubAllEnvs()
  })

  // A caller-named session the host no longer has is created too, so it falls back like a fresh one.
  it.each([
    { name: 'a fresh start', window: {}, host: {} },
    {
      name: 'a dead caller-named session',
      window: { sessionId: 'pty-gone-window' },
      host: { sessionId: 'pty-gone-host' }
    }
  ])('a deleted folder, $name: both lanes start in the workspace root and say so', async (c) => {
    setMainPlatform('darwin')
    const missing = `${POSIX_PATH}/deleted`
    statSyncMock.mockImplementation((target: string) => {
      if (target === missing) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return { isDirectory: () => true, mode: 0o755 }
    })
    const lanes = startParityLanes(suite, { workspace: POSIX_REPO })
    const facts = await spawnBoth(
      lanes,
      POSIX_REPO,
      { cwd: missing, ...c.window },
      { cwd: missing, ...c.host }
    )

    const fallback = { kind: 'worktree', cwd: POSIX_PATH }
    expect(facts.window).toMatchObject({
      cwd: POSIX_PATH,
      result: { startupCwdFallback: fallback }
    })
    expect(facts.host).toMatchObject({ cwd: POSIX_PATH, created: { startupCwdFallback: fallback } })
    expect(lanes.reveal).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.not.objectContaining({ startupCwdFallback: expect.anything() })
    )
  })

  it.each([
    {
      name: 'a folder containing a WSL-project repo',
      workspace: {
        kind: 'folder',
        path: String.raw`C:\Users\alice`,
        repoPath: WIN_PATH,
        projectRuntime: WSL_UBUNTU
      } satisfies LaunchWorkspace,
      host: { shellOverride: 'powershell.exe', terminalWindowsWslDistro: null }
    },
    {
      name: 'a \\wsl$ repo with no saved runtime',
      workspace: { kind: 'repo', path: WSL_PATH } satisfies LaunchWorkspace,
      // The distro comes from the path, but the shell stays the settings' PowerShell.
      host: { shellOverride: 'powershell.exe', terminalWindowsWslDistro: 'Ubuntu' }
    }
  ])('Windows plain terminal, $name: the window uses the sent runtime', async (c) => {
    setMainPlatform('win32')
    const lanes = startParityLanes(suite, { workspace: c.workspace })
    const facts = await spawnBoth(lanes, c.workspace, { projectRuntime: WSL_PROJECT_SENT })

    expect(facts.window).toMatchObject({
      shellOverride: 'wsl.exe',
      terminalWindowsWslDistro: 'Ubuntu'
    })
    expect(facts.host).toMatchObject(c.host)
  })

  // Managed SSH hosts expose this shell environment; the shared resolver serves both lanes.
  it('Windows managed SSH host: both lanes open the OpenSSH login shell', async () => {
    setMainPlatform('win32')
    vi.stubEnv('ORCA_ORCAD_MANAGED_ACTIVATION_ROOT', '/activation')
    vi.mocked(readOpenSshDefaultShell).mockReturnValue(LOGIN_SHELL)
    const workspace = { kind: 'repo', path: WIN_PATH } satisfies LaunchWorkspace
    const lanes = startParityLanes(suite, { workspace })
    const facts = await spawnBoth(lanes, workspace, {})

    expect(facts.window).toMatchObject({ shellOverride: LOGIN_SHELL })
    expect(facts.host).toMatchObject({ shellOverride: LOGIN_SHELL })
  })
})

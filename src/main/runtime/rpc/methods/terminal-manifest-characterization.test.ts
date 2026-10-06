import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { TERMINAL_SPLIT_RATIO_LOCAL_DESKTOP_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { setRuntimeDesktopSurface } from '../../runtime-desktop-surface'
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../../runtime-rpc/runtime-rpc-mobile-method-allowlist'
import { RpcDispatcher } from '../dispatcher'
import { TERMINAL_METHODS } from './terminal'
import { eraseRpcMethods } from '../core'
import {
  TerminalMultiplexLegacyAckFrame,
  TerminalMultiplexSourceRangeAckFrame,
  TerminalMultiplexSubscribeFrame
} from './terminal/stream-schemas'

afterEach(() => setRuntimeDesktopSurface(null))

class NativeSplitRpcRuntime extends OrcaRuntimeService {
  sourceHandle(ptyId: string): string {
    const pty = this.ptysById.get(ptyId)
    if (!pty) {
      throw new Error('missing split source')
    }
    return this.issuePtyHandle(pty)
  }
}

function nativeSplitDispatchHarness() {
  const worktreeId = 'repo::/workspace'
  const tabId = 'split-tab'
  const leafId = '11111111-1111-4111-8111-111111111111'
  const ptyId = 'split-source'
  const repo = { id: 'repo', path: '/workspace', executionHostId: 'local' }
  let session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [worktreeId]: [
        {
          id: tabId,
          worktreeId,
          ptyId,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [tabId]: {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leafId]: ptyId }
      }
    }
  }
  const setWorkspaceSession = vi.fn((next: WorkspaceSessionState) => {
    session = next
  })
  const store = {
    getRepos: () => [repo],
    getRepo: () => repo,
    getWorktreeMeta: () => ({ hostId: 'local' }),
    getFolderWorkspaces: () => [],
    getProjectGroups: () => [],
    getWorkspaceSession: () => session,
    setWorkspaceSession,
    persistPtyBinding: () => true
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this native split fixture supplies every store method used by the production path.
  const runtime = new NativeSplitRpcRuntime(store as never)
  const window = { isDestroyed: () => false, webContents: { isDestroyed: () => false } }
  setRuntimeDesktopSurface({
    showNotification: () => false,
    onIpc: () => {},
    removeIpcListener: () => {},
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: eligibility reads only this window's liveness and identity.
    findWindowById: () => window as never
  })
  const spawn = vi.fn(async () => ({ id: 'split-new' }))
  const reveal = vi.fn(async () => ({ tabId }))
  runtime.setPtyController({
    spawn,
    hasPty: () => true,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  runtime.setNotifier({
    revealTerminalSession: reveal,
    worktreesChanged: vi.fn(),
    reposChanged: vi.fn(),
    activateWorktree: vi.fn(),
    createTerminal: vi.fn(),
    splitTerminal: vi.fn(),
    renameTerminal: vi.fn(),
    focusTerminal: vi.fn(),
    closeTerminal: vi.fn(),
    sleepWorktree: vi.fn(),
    terminalFitOverrideChanged: vi.fn(),
    terminalDriverChanged: vi.fn()
  })
  runtime.registerPty(ptyId, worktreeId, null, { tabId, leafId, incarnationId: 'source' }, false)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId,
        worktreeId,
        title: 'Terminal',
        activeLeafId: leafId,
        layout: { type: 'leaf', leafId }
      }
    ],
    leaves: [{ tabId, worktreeId, leafId, ptyId, paneRuntimeId: 1 }]
  })
  const handle = runtime.sourceHandle(ptyId)
  const launch = vi.fn(async () => ({
    scope: { id: worktreeId, path: '/workspace', connectionId: null, repo, folderWorkspace: null },
    managedWorktree: { repoId: repo.id, hostId: 'local' }
  }))
  Object.assign(runtime, { resolveTerminalWorkspaceLaunchTarget: launch })
  setWorkspaceSession.mockClear()
  return {
    runtime,
    handle,
    spawn,
    reveal,
    launch,
    setWorkspaceSession,
    split: vi.spyOn(runtime, 'splitTerminal'),
    getSession: () => session,
    tabId
  }
}

const METHOD_CASES: readonly (readonly [string, unknown, boolean])[] = [
  ['terminal.list', {}, false],
  ['terminal.resolveActive', {}, false],
  ['terminal.resolvePane', { paneKey: 'pane' }, false],
  ['terminal.recoverPane', { paneKey: 'pane', worktreeId: 'worktree' }, false],
  ['terminal.show', { terminal: 'term' }, false],
  ['terminal.resolveIdentity', { terminal: 'term' }, false],
  ['terminal.read', { terminal: 'term' }, false],
  ['terminal.inspectProcess', { terminal: 'term' }, false],
  ['terminal.isRunningAgent', { terminal: 'term' }, false],
  ['terminal.agentStatus', { terminal: 'term' }, false],
  ['terminal.rename', { terminal: 'term', title: null }, false],
  ['terminal.clearBuffer', { terminal: 'term' }, false],
  ['terminal.resetInputModes', { terminal: 'term' }, false],
  ['terminal.send', { terminal: 'term', text: 'x' }, false],
  ['terminal.wait', { terminal: 'term', for: 'exit' }, false],
  ['terminal.create', {}, false],
  ['terminal.split', { terminal: 'term' }, false],
  ['terminal.stop', { worktree: 'worktree' }, false],
  ['terminal.closeAll', { worktree: 'worktree' }, false],
  ['terminal.sleep', { worktree: 'worktree' }, false],
  ['terminal.stopExact', { worktree: 'worktree', expectedPtyIds: ['pty'] }, false],
  ['terminal.resizeForClient', { terminal: 'term', mode: 'restore', clientId: 'client' }, false],
  ['terminal.focus', { terminal: 'term' }, false],
  ['terminal.close', { terminal: 'term' }, false],
  ['terminal.closeTab', { terminal: 'term' }, false],
  ['agentTeams.tmuxCompat', { teamId: 'team', token: 'token', envPane: 'pane', argv: [] }, false],
  ['agentTeams.prepareLaunch', { paneKey: 'pane' }, false],
  ['terminal.setDisplayMode', { terminal: 'term', mode: 'auto' }, false],
  ['terminal.restoreFit', { terminal: 'term' }, false],
  ['terminal.getDisplayMode', { terminal: 'term' }, false],
  [
    'terminal.updateViewport',
    { terminal: 'term', client: { id: 'client' }, viewport: { cols: 80, rows: 24 } },
    false
  ],
  ['terminal.multiplex', {}, true],
  ['terminal.subscribe', { terminal: 'term' }, true],
  ['terminal.unsubscribe', { subscriptionId: 'term' }, false],
  ['terminal.getAutoRestoreFit', {}, false],
  ['terminal.setAutoRestoreFit', { ms: null }, false],
  ['terminal.setViewerColors', { colors: { foreground: '#ffffff', background: '#000000' } }, false]
]

function schemaFor(name: string) {
  const method = eraseRpcMethods(TERMINAL_METHODS).find((candidate) => candidate.name === name)
  if (!method?.params) {
    throw new Error(`Missing terminal schema: ${name}`)
  }
  return method.params
}
async function invoke(name: string, params: unknown, runtime: Partial<OrcaRuntimeService>) {
  const method = eraseRpcMethods(TERMINAL_METHODS).find((candidate) => candidate.name === name)
  if (!method?.params || 'stream' in method) {
    throw new Error(`Missing unary terminal method: ${name}`)
  }
  return method.handler(method.params.parse(params), { runtime: runtime as OrcaRuntimeService })
}

describe('terminal RPC manifest characterization', () => {
  it('preserves all method names, order, streaming flags, and parseable minimum inputs', () => {
    expect(TERMINAL_METHODS).toHaveLength(37)
    expect(TERMINAL_METHODS.map((method) => [method.name, 'stream' in method])).toEqual(
      METHOD_CASES.map(([name, _params, stream]) => [name, stream])
    )
    expect(new Set(TERMINAL_METHODS.map((method) => method.name)).size).toBe(37)
    for (const [name, params] of METHOD_CASES) {
      expect(() => schemaFor(name).parse(params), name).not.toThrow()
    }
  })

  it('keeps legacy coercion and viewport-boundary differences', () => {
    expect(schemaFor('terminal.list').parse({ limit: 'invalid' })).toEqual({})
    expect(schemaFor('terminal.split').parse({ terminal: 'term', direction: 'diagonal' })).toEqual({
      terminal: 'term'
    })
    expect(() => schemaFor('terminal.rename').parse({ terminal: 'term' })).toThrow()
    expect(schemaFor('terminal.rename').parse({ terminal: 'term', title: '' })).toEqual({
      terminal: 'term',
      title: ''
    })
    expect(() =>
      schemaFor('terminal.updateViewport').parse({
        terminal: 'term',
        client: { id: 'client' },
        viewport: { cols: 1025, rows: 120 }
      })
    ).toThrow()
    expect(() =>
      schemaFor('terminal.updateViewport').parse({
        terminal: 'term',
        client: { id: 'client' },
        viewport: { cols: 1024, rows: 120 }
      })
    ).not.toThrow()
    expect(() =>
      schemaFor('terminal.subscribe').parse({
        terminal: 'term',
        viewport: { cols: 1000, rows: 500 }
      })
    ).not.toThrow()
    expect(() =>
      schemaFor('terminal.setDisplayMode').parse({
        terminal: 'term',
        mode: 'auto',
        viewport: { cols: 1001, rows: 501 }
      })
    ).not.toThrow()
  })

  it('keeps multiplex control objects strict while subscribe remains skew-tolerant', () => {
    expect(TerminalMultiplexLegacyAckFrame.safeParse({ bytes: 1, future: true }).success).toBe(
      false
    )
    expect(
      TerminalMultiplexSourceRangeAckFrame.safeParse({
        streamGeneration: 'generation',
        ackedEndByte: 1,
        future: true
      }).success
    ).toBe(false)
    expect(
      TerminalMultiplexSubscribeFrame.parse({
        streamId: 1,
        terminal: 'term',
        futureCapability: 1
      })
    ).toEqual({ streamId: 1, terminal: 'term' })
  })

  it.each([null, '', true, '0.85', 0, 1, -0.1, 1.1, Number.NaN, Infinity, -Infinity])(
    'rejects malformed split ratio %s before invoking the runtime',
    async (ratio) => {
      const splitTerminal = vi.fn()
      await expect(
        invoke('terminal.split', { terminal: 'term', ratio }, { splitTerminal })
      ).rejects.toThrow()
      expect(splitTerminal).not.toHaveBeenCalled()
    }
  )

  it('forwards a valid split ratio while omission keeps the legacy runtime options', async () => {
    const splitTerminal = vi.fn().mockResolvedValue({ handle: 'term-new' })
    await invoke('terminal.split', { terminal: 'term', ratio: 0.85 }, { splitTerminal })
    expect(splitTerminal).toHaveBeenLastCalledWith('term', {
      direction: undefined,
      command: undefined,
      env: undefined,
      telemetrySource: undefined,
      ratio: 0.85
    })
    await invoke('terminal.split', { terminal: 'term' }, { splitTerminal })
    expect(splitTerminal).toHaveBeenLastCalledWith('term', {
      direction: undefined,
      command: undefined,
      env: undefined,
      telemetrySource: undefined
    })
  })

  it.each([
    { label: 'empty', clientCapabilities: [] },
    {
      label: 'advertised',
      clientCapabilities: [TERMINAL_SPLIT_RATIO_LOCAL_DESKTOP_RUNTIME_CAPABILITY]
    }
  ])(
    'refuses paired runtime ratio with $label capabilities before runtime effects',
    async ({ clientCapabilities }) => {
      const h = nativeSplitDispatchHarness()
      const before = structuredClone(h.getSession())
      const replies: string[] = []
      const dispatcher = new RpcDispatcher({ runtime: h.runtime, methods: TERMINAL_METHODS })
      await dispatcher.dispatchStreaming(
        {
          id: 'ratio',
          authToken: 'test',
          method: 'terminal.split',
          params: { terminal: h.handle, ratio: 0.85 }
        },
        (reply) => replies.push(reply),
        {
          clientKind: 'runtime',
          pairedDeviceId: 'paired-device',
          clientId: 'paired-client',
          connectionId: 'paired-socket',
          clientCapabilities
        }
      )
      expect(replies).toHaveLength(1)
      expect({
        response: JSON.parse(replies[0]),
        effectCalls: [h.split, h.launch, h.spawn, h.reveal, h.setWorkspaceSession].map(
          (effect) => effect.mock.calls.length
        ),
        session: h.getSession()
      }).toMatchObject({
        response: { ok: false, error: { code: 'invalid_argument' } },
        effectCalls: [0, 0, 0, 0, 0],
        session: before
      })
      expect(h.getSession()).toEqual(before)
    }
  )

  it.each([
    { clientKind: undefined, ratio: 0.85 },
    { clientKind: undefined, ratio: undefined },
    { clientKind: 'runtime' as const, ratio: undefined }
  ])(
    'preserves local ratio and omitted splits for $clientKind / $ratio',
    async ({ clientKind, ratio }) => {
      const h = nativeSplitDispatchHarness()
      const replies: string[] = []
      const dispatcher = new RpcDispatcher({ runtime: h.runtime, methods: TERMINAL_METHODS })
      await dispatcher.dispatchStreaming(
        {
          id: 'split',
          authToken: 'test',
          method: 'terminal.split',
          params: { terminal: h.handle, ...(ratio !== undefined ? { ratio } : {}) }
        },
        (reply) => replies.push(reply),
        { clientKind }
      )
      expect(replies).toHaveLength(1)
      expect(JSON.parse(replies[0])).toMatchObject({ ok: true })
      expect(h.split).toHaveBeenCalledOnce()
      expect(h.spawn).toHaveBeenCalledOnce()
      expect(h.reveal).toHaveBeenCalledOnce()
      const root = h.getSession().terminalLayoutsByTabId[h.tabId]?.root
      expect(root).toMatchObject({ type: 'split' })
      if (ratio === undefined) {
        expect(h.split.mock.calls[0]?.[1]).not.toHaveProperty('ratio')
        expect(root).not.toHaveProperty('ratio')
      } else {
        expect(root).toHaveProperty('ratio', ratio)
      }
    }
  )

  it('keeps terminal.split excluded from the mobile transport allowlist', () => {
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has('terminal.split')).toBe(false)
  })

  it('returns execution-host authority from lifecycle handlers without reinterpretation', async () => {
    const pane = {
      handle: 'term-pane',
      executionHostId: 'ssh-host',
      hostPlatform: 'win32'
    }
    const recovered = {
      handle: 'term-recovered',
      executionHostId: 'folder-host',
      hostPlatform: 'linux'
    }
    const shown = {
      handle: 'term-shown',
      executionHostId: 'ssh-host',
      hostPlatform: 'win32'
    }
    const split = {
      handle: 'term-split',
      executionHostId: 'folder-host',
      hostPlatform: 'linux'
    }
    const runtime = {
      resolveTerminalPane: vi.fn(() => pane),
      recoverTerminalPane: vi.fn(async () => recovered),
      showTerminal: vi.fn(async () => shown),
      splitTerminal: vi.fn(async () => split)
    } as unknown as Partial<OrcaRuntimeService>

    await expect(invoke('terminal.resolvePane', { paneKey: 'pane' }, runtime)).resolves.toEqual({
      terminal: pane
    })
    await expect(
      invoke('terminal.recoverPane', { paneKey: 'pane', worktreeId: 'folder-worktree' }, runtime)
    ).resolves.toEqual({ terminal: recovered })
    await expect(invoke('terminal.show', { terminal: 'term' }, runtime)).resolves.toEqual({
      terminal: shown
    })
    await expect(invoke('terminal.split', { terminal: 'term' }, runtime)).resolves.toEqual({
      split
    })
  })

  it('keeps remote and folder selectors opaque through terminal.create', async () => {
    const created = {
      handle: 'term-created',
      executionHostId: 'ssh-host',
      hostPlatform: 'win32'
    }
    const createTerminal = vi.fn(async () => created)
    const runtime = {
      dedupeTerminalCreate: vi.fn(
        async (
          _owner: string,
          selector: string | undefined,
          _mutationId: string | undefined,
          _reconcile: boolean,
          create: (selector: string | undefined, preAllocatedHandle?: string) => Promise<unknown>
        ) => create(selector, 'term-preallocated')
      ),
      createTerminal
    } as unknown as Partial<OrcaRuntimeService>
    const selector = 'ssh://windows-host/C:/Users/dev/repo'

    await expect(
      invoke(
        'terminal.create',
        { worktree: selector, clientMutationId: 'mutation', command: 'provider resume-token' },
        runtime
      )
    ).resolves.toEqual({ terminal: created })
    expect(createTerminal).toHaveBeenCalledWith(
      selector,
      expect.objectContaining({
        command: 'provider resume-token',
        preAllocatedHandle: 'term-preallocated'
      })
    )
  })
})

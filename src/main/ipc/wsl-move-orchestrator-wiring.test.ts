import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../shared/wsl-host-internal-gate'
import { WSL_MOVE_ORCHESTRATOR_SLEPT_PANES_REQUEST_CHANNEL } from '../../shared/wsl-move/wsl-move-orchestrator-types'

type Handler = (event: unknown, request?: unknown) => unknown

const handlers = vi.hoisted(() => new Map<string, Handler>())
const sent = vi.hoisted((): { channel: string; payload: unknown }[] => [])
vi.mock('electron', () => ({
  app: { getPath: () => '/user-data', getVersion: () => '1.0.0' },
  ipcMain: {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler)
  }
}))
const MAIN_WINDOW_ID = 7
vi.mock('./ui', () => {
  const webContents = {
    id: MAIN_WINDOW_ID,
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => sent.push({ channel, payload })
  }
  return {
    getTrustedUIRendererWebContents: () => webContents,
    getTrustedUIRendererWindow: () => ({ isDestroyed: () => false, webContents })
  }
})
type Status = { distro: string; state: string; environmentId: string; detail: null }
type RunningRead = { status: 'confirmed'; distros: string[] } | { status: 'unavailable' }
const host = vi.hoisted(() => {
  const initial = (): RunningRead => ({ status: 'confirmed', distros: ['Ubuntu'] })
  return {
    statuses: new Array<Status>(),
    listeners: new Set<() => void>(),
    running: initial(),
    added: new Array<string>()
  }
})
const deployments = vi.hoisted(() => new Map<string, Record<string, unknown>>())
vi.mock('../../shared/runtime-environment-wsl-host-store', () => ({
  findWslHostDeployment: (_userData: string, environmentId: string) =>
    deployments.get(environmentId) ?? null
}))
const hostFile = vi.hoisted(() => ({ unreadable: false }))
vi.mock('../../shared/wsl-host-deployment-store', () => ({
  readWslHostDeployments: () => {
    if (hostFile.unreadable) {
      throw new Error('orca-wsl-host-deployments.json is not valid')
    }
    return { deployments: [], unreadableEnvironmentIds: new Set() }
  }
}))
vi.mock('../wsl/wsl-distro-registry-id', () => ({ readWslDistroRegistrations: async () => null }))
vi.mock('../wsl/wsl-orcad-deploy', () => ({
  defaultWslOrcadEnvironmentId: (distro: string) => `wsl:${distro}`
}))
vi.mock('../wsl-background-distro-gate', () => ({
  readConfirmedRunningWslDistros: async () => host.running,
  // The user-act gate notes a woken distro when the act settles.
  noteWslDistroWoken: vi.fn(),
  noteWslDistroMayHaveStopped: vi.fn(),
  noteWslDistrosRunning: vi.fn(),
  readWslDistroRunningState: vi.fn(async () => 'running')
}))
vi.mock('../wsl/wsl-host-service-instance', () => ({
  getWslHostService: () => ({
    getStatuses: () => host.statuses,
    onStatusesChanged: (listener: () => void) => {
      host.listeners.add(listener)
      return () => host.listeners.delete(listener)
    },
    recordForEnvironment: () => null,
    connect: async () => {},
    // A bridge user's host: adding it makes it ready.
    add: async ({ distro }: { distro: string }) => {
      host.added.push(distro)
      host.statuses.push({ distro, state: 'ready', environmentId: `wsl:${distro}`, detail: null })
      return { ok: true, environmentId: `wsl:${distro}` }
    }
  })
}))
const driver = vi.hoisted(() => ({
  previewWslMove: vi.fn(async (_deps: unknown, request: { distro: string }) => ({
    outcome: 'ready',
    distro: request.distro,
    repoIds: ['r1'],
    folderWorkspaceIds: [],
    changed: [],
    heldByHost: [],
    refused: [],
    blockers: []
  })),
  moveProjectsToWslHost: vi.fn(async () => ({
    outcome: 'moved',
    migrationId: 'm1',
    phase: 'retained',
    reloadRequired: true
  }))
}))
vi.mock('../persistence/moving-wsl-projects/wsl-move-driver', () => driver)
const journal = vi.hoisted(() => ({ unreadable: false }))
vi.mock('../persistence/moving-wsl-projects/wsl-move-cutover-journal', () => ({
  listWslMoveCutoverChain: () => {
    if (journal.unreadable) {
      throw new Error('wsl_move_journal_unreadable')
    }
    return []
  }
}))
const store = vi.hoisted(() => ({ reads: 0, records: new Map<string, unknown>() }))
vi.mock('../persistence/moving-wsl-projects/wsl-move-orchestrator-store', () => ({
  readWslMoveOrchestratorRecords: () => {
    store.reads++
    return store.records
  },
  writeWslMoveOrchestratorRecords: () => {}
}))
const hostActions = vi.hoisted(() => ({
  listeners: new Array<(action: { kind: 'added' | 'removed'; distro: string }) => void>()
}))
vi.mock('../wsl/wsl-host-user-actions', () => ({
  onWslHostUserAction: (
    listener: (action: { kind: 'added' | 'removed'; distro: string }) => void
  ) => {
    hostActions.listeners.push(listener)
    return () => {}
  }
}))
const releases = vi.hoisted(() => ({ listeners: new Array<(distro: string) => void>() }))
vi.mock('./wsl-move-release-here', () => ({
  releaseWslMoveChainHere: vi.fn(),
  onWslMoveReleasedByUser: (listener: (distro: string) => void) => {
    releases.listeners.push(listener)
    return () => {}
  }
}))
vi.mock('./wsl-move-undo-wiring', () => ({ createWslMoveUndoPorts: vi.fn() }))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))

const sleptPanes = [{ paneKey: 'tab:leaf', sessionId: 'wt@@a' }]

function requestIdOf(payload: unknown): string {
  return typeof payload === 'object' &&
    payload !== null &&
    'requestId' in payload &&
    typeof payload.requestId === 'string'
    ? payload.requestId
    : ''
}

/** The profile's projects: one bridge project on Ubuntu keeps its record from being pruned. */
const profile = vi.hoisted(() => ({
  repos: [{ id: 'r1', path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\app', connectionId: null }]
}))

async function register(): Promise<void> {
  const { registerWslMoveOrchestrator } = await import('./wsl-move-orchestrator-wiring')
  const store = { getRepos: () => profile.repos, getFolderWorkspaces: () => [] }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The wiring reads only the projects of the store, and the driver is mocked.
  registerWslMoveOrchestrator(store as never, () => ({ now: () => new Date(0) }) as never)
}

/** Answers every slept-pane request the window has been sent. */
async function answerWindow(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) {
    for (const message of sent.splice(0)) {
      if (message.channel === WSL_MOVE_ORCHESTRATOR_SLEPT_PANES_REQUEST_CHANNEL) {
        const requestId = requestIdOf(message.payload)
        await handlers.get('wslMoveOrchestrator:answerSleptPanes')?.(
          { sender: { id: MAIN_WINDOW_ID } },
          { requestId, sleptPanes }
        )
      }
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
}

// Why: the first import transforms the wiring's module graph, which alone can pass the 30 s test
// timeout on a loaded machine; later imports after resetModules reuse the transform.
beforeAll(async () => {
  await import('./wsl-move-orchestrator-wiring')
}, 120_000)

beforeEach(() => {
  vi.resetModules()
  handlers.clear()
  sent.length = 0
  host.statuses = []
  host.listeners.clear()
  host.running = { status: 'confirmed', distros: ['Ubuntu'] }
  host.added = []
  releases.listeners.length = 0
  hostFile.unreadable = false
  hostActions.listeners.length = 0
  deployments.clear()
  store.reads = 0
  store.records = new Map()
  journal.unreadable = false
  driver.previewWslMove.mockClear()
  driver.moveProjectsToWslHost.mockClear()
})
afterEach(() => vi.unstubAllEnvs())

describe('WSL move orchestrator wiring', () => {
  it('stays dark with the gate closed: nothing read, nothing listed', async () => {
    host.statuses = [
      { distro: 'Ubuntu', state: 'ready', environmentId: 'wsl:Ubuntu', detail: null }
    ]
    await register()
    expect(store.reads).toBe(0)
    expect(await handlers.get('wslMoveOrchestrator:list')?.({})).toEqual([])
    expect(sent).toEqual([])
  })

  it('moves a distro whose host is ready at start, with the window slept panes', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
    host.statuses = [
      { distro: 'Ubuntu', state: 'ready', environmentId: 'wsl:Ubuntu', detail: null }
    ]
    await register()
    await answerWindow()
    expect(driver.previewWslMove).toHaveBeenCalledWith(expect.anything(), {
      distro: 'Ubuntu',
      sleptPanes
    })
    expect(driver.moveProjectsToWslHost).toHaveBeenCalledWith(expect.anything(), {
      distro: 'Ubuntu',
      sleptPanes
    })
  })

  it('starts on a host reaching ready, never on one that is not', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
    host.statuses = [
      { distro: 'Ubuntu', state: 'connecting', environmentId: 'wsl:Ubuntu', detail: null }
    ]
    await register()
    await answerWindow()
    expect(driver.previewWslMove).not.toHaveBeenCalled()
    host.statuses = [
      { distro: 'Ubuntu', state: 'ready', environmentId: 'wsl:Ubuntu', detail: null }
    ]
    for (const listener of host.listeners) {
      listener()
    }
    await answerWindow()
    expect(driver.moveProjectsToWslHost).toHaveBeenCalledTimes(1)
  })

  it('makes no automatic start with ORCA_WSL_MOVE_AUTO=0', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
    vi.stubEnv('ORCA_WSL_MOVE_AUTO', '0')
    host.statuses = [
      { distro: 'Ubuntu', state: 'ready', environmentId: 'wsl:Ubuntu', detail: null }
    ]
    await register()
    await answerWindow()
    expect(driver.previewWslMove).not.toHaveBeenCalled()
  })

  it('ignores a slept-pane answer from another window', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
    host.statuses = [
      { distro: 'Ubuntu', state: 'ready', environmentId: 'wsl:Ubuntu', detail: null }
    ]
    await register()
    const request = sent.find(
      (message) => message.channel === WSL_MOVE_ORCHESTRATOR_SLEPT_PANES_REQUEST_CHANNEL
    )
    const requestId = requestIdOf(request?.payload)
    await handlers.get('wslMoveOrchestrator:answerSleptPanes')?.(
      { sender: { id: 99 } },
      { requestId, sleptPanes }
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect(driver.previewWslMove).not.toHaveBeenCalled()
  })

  it('T2: a bridge project opened on a running distro adds its host and moves it', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
    await register()
    await handlers.get('wslMoveOrchestrator:projectOpened')?.(
      { sender: { id: MAIN_WINDOW_ID } },
      'Ubuntu'
    )
    await answerWindow()
    expect(host.added).toEqual(['Ubuntu'])
    expect(driver.moveProjectsToWslHost).toHaveBeenCalledTimes(1)
  })

  it('T2: never adds a host for a stopped distro or one whose state cannot be read', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
    await register()
    host.running = { status: 'confirmed', distros: [] }
    await handlers.get('wslMoveOrchestrator:projectOpened')?.(
      { sender: { id: MAIN_WINDOW_ID } },
      'Ubuntu'
    )
    host.running = { status: 'unavailable' }
    await handlers.get('wslMoveOrchestrator:projectOpened')?.(
      { sender: { id: MAIN_WINDOW_ID } },
      'Debian'
    )
    await answerWindow()
    expect(host.added).toEqual([])
    expect(driver.previewWslMove).not.toHaveBeenCalled()
  })

  it('T3: a ready host whose distro is not confirmed running is not resumed', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
    host.running = { status: 'unavailable' }
    host.statuses = [
      { distro: 'Ubuntu', state: 'ready', environmentId: 'wsl:Ubuntu', detail: null }
    ]
    await register()
    await answerWindow()
    expect(driver.previewWslMove).not.toHaveBeenCalled()
  })

  // Review #2: "Use on this computer again" parks the distro, so opening it again moves nothing.
  it('parks a distro the user brought back', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
    await register()
    for (const listener of releases.listeners) {
      listener('Ubuntu')
    }
    const records = await handlers.get('wslMoveOrchestrator:list')?.({})
    expect(records).toEqual([
      expect.objectContaining({
        distro: 'Ubuntu',
        state: { kind: 'parked', reason: 'declined', cause: 'released-here' }
      })
    ])
  })

  // E11 (#33843): `pendingStop` is optional until that PR lands, so the guard reads it loosely.
  it('never adds, connects or moves a host whose Remove is pending', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
    deployments.set('wsl:Ubuntu', {
      environmentId: 'wsl:Ubuntu',
      distro: 'Ubuntu',
      pendingStop: { reason: 'server-still-running' }
    })
    host.statuses = [
      { distro: 'Ubuntu', state: 'ready', environmentId: 'wsl:Ubuntu', detail: null }
    ]
    await register()
    await handlers.get('wslMoveOrchestrator:projectOpened')?.(
      { sender: { id: MAIN_WINDOW_ID } },
      'Ubuntu'
    )
    await answerWindow()
    expect(host.added).toEqual([])
    expect(driver.previewWslMove).not.toHaveBeenCalled()
    expect(await handlers.get('wslMoveOrchestrator:list')?.({})).toEqual([
      expect.objectContaining({ state: { kind: 'parked', reason: 'removal-pending' } })
    ])
  })

  // Re-review 1: registerCoreHandlers calls this before many other handlers; it must not throw.
  it('registers everything and keeps an offered Restore when the journal is unreadable', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
    journal.unreadable = true
    store.records = new Map([
      [
        'local-wsl:ubuntu',
        {
          distro: 'Ubuntu',
          state: { kind: 'restore-offered' },
          attempts: 0,
          appVersion: '1.0.0',
          updatedAt: 0
        }
      ]
    ])
    await expect(register()).resolves.toBeUndefined()
    for (const channel of [
      'wslMoveOrchestrator:list',
      'wslMoveOrchestrator:projectOpened',
      'wslMoveOrchestrator:userAction',
      'wslMoveOrchestrator:answerSleptPanes'
    ]) {
      expect(handlers.has(channel)).toBe(true)
    }
    expect(await handlers.get('wslMoveOrchestrator:list')?.({})).toEqual([
      expect.objectContaining({ state: { kind: 'restore-offered' } })
    ])
  })

  // A user Remove declines the host: T2 must not add it back; the user's own Add resumes.
  it('never re-adds a host the user removed, until the user adds it', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
    await register()
    for (const listener of hostActions.listeners) {
      listener({ kind: 'removed', distro: 'Ubuntu' })
    }
    await handlers.get('wslMoveOrchestrator:projectOpened')?.(
      { sender: { id: MAIN_WINDOW_ID } },
      'Ubuntu'
    )
    await answerWindow()
    expect(host.added).toEqual([])
    expect(driver.previewWslMove).not.toHaveBeenCalled()
    for (const listener of hostActions.listeners) {
      listener({ kind: 'added', distro: 'Ubuntu' })
    }
    expect(await handlers.get('wslMoveOrchestrator:list')?.({})).toEqual([
      expect.objectContaining({ distro: 'Ubuntu', state: { kind: 'pending' } })
    ])
  })

  // Review 3 #3: a release while the start waits for the window's panes must not be moved.
  it('does not start a move the user released while the window answered', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
    host.statuses = [
      { distro: 'Ubuntu', state: 'ready', environmentId: 'wsl:Ubuntu', detail: null }
    ]
    await register()
    // Answer the preview's request only, then release before answering the start's.
    const answerOne = async (): Promise<boolean> => {
      for (let turn = 0; turn < 50; turn++) {
        const index = sent.findIndex(
          (message) => message.channel === WSL_MOVE_ORCHESTRATOR_SLEPT_PANES_REQUEST_CHANNEL
        )
        if (index !== -1) {
          const [message] = sent.splice(index, 1)
          await handlers.get('wslMoveOrchestrator:answerSleptPanes')?.(
            { sender: { id: MAIN_WINDOW_ID } },
            { requestId: requestIdOf(message?.payload), sleptPanes }
          )
          return true
        }
        await new Promise((resolve) => setImmediate(resolve))
      }
      return false
    }
    expect(await answerOne()).toBe(true)
    await vi.waitFor(() =>
      expect(
        sent.some(
          (message) => message.channel === WSL_MOVE_ORCHESTRATOR_SLEPT_PANES_REQUEST_CHANNEL
        )
      ).toBe(true)
    )
    for (const listener of releases.listeners) {
      listener('Ubuntu')
    }
    expect(await answerOne()).toBe(true)
    await answerWindow()
    expect(driver.previewWslMove).toHaveBeenCalledTimes(1)
    expect(driver.moveProjectsToWslHost).not.toHaveBeenCalled()
  })

  // Pre-review #3: a host file that cannot be read must never make a distro look gone.
  it('prunes nothing when the WSL host file cannot be read', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
    hostFile.unreadable = true
    const savedRepos = profile.repos
    profile.repos = []
    store.records = new Map([
      [
        'local-wsl:ubuntu',
        {
          distro: 'Ubuntu',
          state: { kind: 'idle' },
          attempts: 0,
          appVersion: '1.0.0',
          updatedAt: 0
        }
      ]
    ])
    try {
      await register()
      expect(await handlers.get('wslMoveOrchestrator:list')?.({})).toEqual([
        expect.objectContaining({ distro: 'Ubuntu' })
      ])
    } finally {
      profile.repos = savedRepos
    }
  })

  it('prunes a distro with no host and no bridge projects once the file reads', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
    const savedRepos = profile.repos
    profile.repos = []
    store.records = new Map([
      [
        'local-wsl:ubuntu',
        {
          distro: 'Ubuntu',
          state: { kind: 'idle' },
          attempts: 0,
          appVersion: '1.0.0',
          updatedAt: 0
        }
      ]
    ])
    try {
      await register()
      expect(await handlers.get('wslMoveOrchestrator:list')?.({})).toEqual([])
    } finally {
      profile.repos = savedRepos
    }
  })

  // #34632's stopped-distro gates: Check again runs the driver as the user's act on its distro,
  // so its reads of a just-connected distro pass; a wake's reads stay background work.
  it('runs the driver for Check again as the user act, and for a wake as background work', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
    const { isWslUserActFor } = await import('../wsl/wsl-user-act-scope')
    const seen: boolean[] = []
    const original = driver.previewWslMove.getMockImplementation()
    driver.previewWslMove.mockImplementation(
      async (_deps: unknown, request: { distro: string }) => {
        seen.push(isWslUserActFor(request.distro))
        return {
          outcome: 'ready',
          distro: request.distro,
          repoIds: ['r1'],
          folderWorkspaceIds: [],
          changed: [],
          heldByHost: [],
          refused: [],
          blockers: []
        }
      }
    )
    host.statuses = [
      { distro: 'Ubuntu', state: 'ready', environmentId: 'wsl:Ubuntu', detail: null }
    ]
    await register()
    await answerWindow()
    await handlers.get('wslMoveOrchestrator:userAction')?.(
      { sender: { id: MAIN_WINDOW_ID } },
      { distro: 'Ubuntu', action: 'retry' }
    )
    await answerWindow()
    if (original) {
      driver.previewWslMove.mockImplementation(original)
    }
    expect(seen).toEqual([false, true])
  })
})

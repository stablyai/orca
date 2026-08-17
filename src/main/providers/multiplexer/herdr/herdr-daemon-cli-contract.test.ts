import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import type { IPty } from 'node-pty'
import { HerdrTransport } from './herdr-transport'
import { HerdrDaemon } from './herdr-daemon-class'
import { restoreHerdrTestDataDir, setHerdrTestDataDir } from './herdr-daemon-test-env'

type DataListener = (data: string) => void
type ExitListener = (event: { exitCode: number; signal?: number }) => void

// Why: pane.create must spawn a PTY. Hosts with flaky nested-session pty
// allocation (CI sandboxes) make real node-pty spawns time-dependent, so the
// contract is tested with a fake IPty instead.
function fakePty(): IPty {
  const dataListeners = new Set<DataListener>()
  const exitListeners = new Set<ExitListener>()
  return {
    pid: 9999,
    cols: 80,
    rows: 24,
    process: '/bin/bash',
    handleFlowControl: false,
    onData: (listener: DataListener) => {
      dataListeners.add(listener)
      return { dispose: () => dataListeners.delete(listener) }
    },
    onExit: (listener: ExitListener) => {
      exitListeners.add(listener)
      return { dispose: () => exitListeners.delete(listener) }
    },
    resize: vi.fn(),
    clear: vi.fn(),
    write: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    spawn: vi.fn()
  } as unknown as IPty
}

// spawnPty is TS-private but a runtime prototype method; swap it for the fake
// during setup, restore afterwards.
const proto = HerdrDaemon.prototype as unknown as Record<'spawnPty', unknown>
const realSpawnPty = proto.spawnPty

// Why: the `orca herdr` CLI (src/cli/handlers/herdr.ts) speaks the identity-v2
// pane.create/session.list contract. These tests pin that the daemon serves it
// from the protocol-19 model.
describe('herdr daemon CLI contract (pane.create / session.list)', () => {
  const originalHome = process.env.HOME
  const originalHerdrDataDir = process.env.HERDR_DATA_DIR
  let server: HerdrTransport | null = null
  let daemon: HerdrDaemon | null = null
  let socketPath = ''

  async function setup(): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), 'herdr-cli-test-'))
    socketPath = join(dir, 'herdr.sock')
    process.env.HOME = dir
    setHerdrTestDataDir(dir)
    proto.spawnPty = fakePty
    server = new HerdrTransport(socketPath)
    daemon = new HerdrDaemon(server)
    await server.startServer()
  }

  async function roundTrip<T>(method: string, params: unknown): Promise<T> {
    const client = new HerdrTransport(socketPath)
    await client.connect()
    try {
      return (await client.request(method, params)) as T
    } finally {
      await client.close()
    }
  }

  afterEach(async () => {
    process.env.HOME = originalHome
    restoreHerdrTestDataDir(originalHerdrDataDir)
    await daemon?.dispose()
    daemon = null
    await server?.close()
    server = null
    proto.spawnPty = realSpawnPty
  })

  type CreateResult = {
    paneId: string
    identity: {
      version: number
      projectId: string
      workspaceId: string
      tabId: string
      leafId: string
      paneId: string
    }
    isReattach: boolean
    snapshot?: string
    snapshotCols?: number
    snapshotRows?: number
  }

  const target = { project: 'demo', workspace: 'wt-1', tab: 'Main', leaf: 'leaf-1' }

  it('creates a pane with the identity v2 shape', async () => {
    await setup()
    const created = await roundTrip<CreateResult>('pane.create', {
      target,
      options: { cols: 100, rows: 40, cwd: '/tmp' }
    })

    expect(created.paneId).toBeTruthy()
    expect(created.identity).toMatchObject({
      version: 2,
      projectId: 'demo',
      workspaceId: 'wt-1',
      tabId: 'Main',
      leafId: 'leaf-1',
      paneId: created.paneId
    })
    expect(created.isReattach).toBe(false)
    expect(created.snapshotCols).toBe(100)
    expect(created.snapshotRows).toBe(40)

    const snapshot = await roundTrip<{ snapshot: { panes: { pane_id: string }[] } }>(
      'session.snapshot',
      {}
    )
    expect(snapshot.snapshot.panes.some((pane) => pane.pane_id === created.paneId)).toBe(true)
  })

  it('reattaches instead of duplicating on a repeated create for the same target', async () => {
    await setup()
    const first = await roundTrip<CreateResult>('pane.create', {
      target,
      options: { cols: 80, rows: 24, cwd: '/tmp' }
    })
    const second = await roundTrip<CreateResult>('pane.create', {
      target,
      options: { cols: 80, rows: 24, cwd: '/tmp' }
    })

    expect(second.isReattach).toBe(true)
    expect(second.paneId).toBe(first.paneId)

    const snapshot = await roundTrip<{ snapshot: { panes: unknown[] } }>('session.snapshot', {})
    expect(snapshot.snapshot.panes).toHaveLength(1)
  })

  it('session.list exposes the created pane with leaf label and agent entry', async () => {
    await setup()
    const created = await roundTrip<CreateResult>('pane.create', {
      target,
      options: { cols: 80, rows: 24, cwd: '/tmp' }
    })

    const list = await roundTrip<{
      sessionList: {
        sessionName: string
        panes: {
          paneId: string
          leafId: string
          title?: string
          agent: { agent: string | null; focused?: boolean }[]
        }[]
      }[]
    }>('session.list', {})

    expect(list.sessionList).toHaveLength(1)
    expect(list.sessionList[0].sessionName).toBe('orca')
    const pane = list.sessionList[0].panes.find((p) => p.paneId === created.paneId)
    expect(pane).toBeDefined()
    expect(pane!.leafId).toBe('leaf-1')
    expect(pane!.title).toBe('Main')
    expect(pane!.agent).toHaveLength(1)
    expect(pane!.agent[0].agent).toBeNull()
  })

  it('closes a created pane and drops it from session.list', async () => {
    await setup()
    const created = await roundTrip<CreateResult>('pane.create', {
      target,
      options: { cols: 80, rows: 24, cwd: '/tmp' }
    })

    await roundTrip('pane.close', { pane_id: created.paneId })

    const list = await roundTrip<{
      sessionList: { panes: { paneId: string }[] }[]
    }>('session.list', {})
    expect(list.sessionList[0].panes.some((p) => p.paneId === created.paneId)).toBe(false)
  })
})

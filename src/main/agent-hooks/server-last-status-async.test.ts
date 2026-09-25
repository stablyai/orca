import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer } from './server'
import { buildBody, postHookEvent, PANE } from './server.test-fixtures'

const { renameMock } = vi.hoisted(() => ({ renameMock: vi.fn() }))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  rename: renameMock
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const filesystem = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

class PersistenceTestServer extends AgentHookServer {
  constructor() {
    super()
    this._setOpenCodeBinderDepsForTests({
      listSessions: () => [],
      listPanes: () => [],
      sweep: async () => []
    })
  }
}

describe('asynchronous last-status persistence', () => {
  let directory: string
  let server: AgentHookServer
  let releaseRename: (() => void) | undefined

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-status-async-'))
    renameMock.mockReset().mockImplementation(filesystem.rename)
    server = new PersistenceTestServer()
    await server.start({ env: 'production', userDataPath: directory })
  })

  afterEach(async () => {
    releaseRename?.()
    releaseRename = undefined
    await server.stop()
    rmSync(directory, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function prompt(): string {
    const persisted = JSON.parse(
      readFileSync(join(directory, 'agent-hooks', 'last-status.json'), 'utf8')
    )
    return persisted.entries[PANE].payload.prompt
  }

  function holdRename(): Promise<void> {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    releaseRename = release.resolve
    renameMock.mockImplementationOnce(async (...args: Parameters<typeof filesystem.rename>) => {
      entered.resolve()
      await release.promise
      await filesystem.rename(...args)
    })
    return entered.promise
  }

  async function submit(value: string): Promise<void> {
    await postHookEvent(server, buildBody({ hook_event_name: 'UserPromptSubmit', prompt: value }))
  }

  it('serves hooks and coalesces newer snapshots while rename is stalled', async () => {
    await submit('first')
    const entered = holdRename()
    const first = server.flushStatusPersist()
    await entered
    await submit('second')
    const second = server.flushStatusPersist()
    await submit('latest')
    const latest = server.flushStatusPersist()
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    expect(renameMock).toHaveBeenCalledTimes(1)
    releaseRename?.()
    await Promise.all([first, second, latest])
    expect(prompt()).toBe('latest')
    expect(renameMock).toHaveBeenCalledTimes(2)
    await server.flushStatusPersist()
    expect(renameMock).toHaveBeenCalledTimes(2)
  })

  it('retries a failed rename without another hook and removes the failed temporary file', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    renameMock.mockRejectedValueOnce(new Error('delayed filesystem failure'))
    await submit('retry me')
    await server.flushStatusPersist()
    expect(renameMock).toHaveBeenCalledTimes(1)
    expect(
      readdirSync(join(directory, 'agent-hooks')).filter((name) => name.endsWith('.tmp'))
    ).toEqual([])
    await vi.waitFor(() => expect(prompt()).toBe('retry me'))
    expect(renameMock).toHaveBeenCalledTimes(2)
  })

  it('joins the final snapshot on shutdown without an older rename rolling it back', async () => {
    await submit('old')
    const entered = holdRename()
    void server.flushStatusPersist()
    await entered
    await submit('final')
    const stopped = server.stop()
    const stoppedAgain = server.stop()
    let settled = false
    void stopped.then(() => {
      settled = true
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    releaseRename?.()
    await Promise.all([stopped, stoppedAgain])
    expect(prompt()).toBe('final')
    expect(renameMock).toHaveBeenCalledTimes(2)
  })

  it('waits for a prior shutdown before hydrating a restarted listener', async () => {
    await submit('restored')
    const entered = holdRename()
    const stopped = server.stop()
    await entered
    const restarted = server.start({ env: 'production', userDataPath: directory })
    releaseRename?.()
    await Promise.all([stopped, restarted])
    expect(server.getStatusSnapshotForPane(PANE)[0]?.prompt).toBe('restored')
  })
})

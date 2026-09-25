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
    await vi.waitFor(() => expect(prompt()).toBe('retry me'), { timeout: 10000 })
    expect(renameMock).toHaveBeenCalledTimes(2)
  })

  it('bounds retries for a failing snapshot and accepts a newer snapshot after exhaustion', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    renameMock.mockRejectedValue(new Error('disk full'))
    await submit('cannot persist')
    await server.flushStatusPersist()
    await vi.waitFor(() => expect(renameMock).toHaveBeenCalledTimes(3), { timeout: 10000 })
    await new Promise<void>((resolve) => setTimeout(resolve, 600))
    expect(renameMock).toHaveBeenCalledTimes(3)
    renameMock.mockImplementation(filesystem.rename)
    await submit('new snapshot')
    await server.flushStatusPersist()
    expect(prompt()).toBe('new snapshot')
  })

  it('keeps storage failure backoff when newer hook snapshots arrive', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    renameMock.mockRejectedValue(new Error('disk full'))
    await submit('first failed snapshot')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    await server.flushStatusPersist()
    await submit('second failed snapshot')
    await server.flushStatusPersist()
    await submit('latest waiting snapshot')
    await new Promise<void>((resolve) => setTimeout(resolve, 300))
    expect(renameMock).toHaveBeenCalledTimes(2)
    clock.mockRestore()
    renameMock.mockImplementation(filesystem.rename)
    await server.flushStatusPersist()
    expect(prompt()).toBe('latest waiting snapshot')
    expect(renameMock).toHaveBeenCalledTimes(3)
  })

  it('rejects a failed shutdown write and retains its final snapshot for an explicit retry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await submit('final snapshot')
    renameMock.mockRejectedValueOnce(new Error('shutdown rename failed'))
    await expect(server.stop()).rejects.toThrow('shutdown rename failed')
    await server.flushStatusPersist()
    expect(prompt()).toBe('final snapshot')
  })

  it('recovers a failed final snapshot before restart hydration', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await submit('recover before hydrate')
    renameMock.mockRejectedValueOnce(new Error('shutdown rename failed'))
    await expect(server.stop()).rejects.toThrow('shutdown rename failed')
    await server.start({ env: 'production', userDataPath: directory })
    expect(server.getStatusSnapshotForPane(PANE)[0]?.prompt).toBe('recover before hydrate')
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
  it('recovers newest final after older and newer failures', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await submit('older')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    releaseRename = release.resolve
    renameMock
      .mockImplementationOnce(async () => {
        entered.resolve()
        await release.promise
        throw new Error('older failed')
      })
      .mockRejectedValueOnce(new Error('newest failed'))
    const first = server.flushStatusPersist()
    await entered.promise
    await submit('newest')
    const stopped = server.stop()
    const firstRejected = expect(first).rejects.toThrow('newest failed')
    const stopRejected = expect(stopped).rejects.toThrow('newest failed')
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    release.resolve()
    await Promise.all([firstRejected, stopRejected])
    await server.flushStatusPersist()
    expect(prompt()).toBe('newest')
    expect(renameMock).toHaveBeenCalledTimes(3)
  })

  it('allows newer final success to supersede older failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await submit('older')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    releaseRename = release.resolve
    renameMock.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      throw new Error('older failed')
    })
    const first = server.flushStatusPersist()
    await entered.promise
    await submit('newest')
    const stopped = server.stop()
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    release.resolve()
    await Promise.all([first, stopped])
    expect(prompt()).toBe('newest')
    expect(renameMock).toHaveBeenCalledTimes(2)
  })

  it('honors backoff for an automatically queued newer snapshot', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await submit('older stalled')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    releaseRename = release.resolve
    renameMock.mockImplementationOnce(async () => {
      entered.resolve()
      await release.promise
      throw new Error('slow failure')
    })
    const first = server.flushStatusPersist()
    await entered.promise
    await submit('newer automatically queued')
    await new Promise<void>((resolve) => setTimeout(resolve, 300))
    expect(renameMock).toHaveBeenCalledTimes(1)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    release.resolve()
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
    expect(renameMock).toHaveBeenCalledTimes(1)
    await first
    clock.mockRestore()
  })
})

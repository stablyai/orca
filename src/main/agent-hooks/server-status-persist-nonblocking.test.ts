import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import { AtomicSnapshotWriter } from '../persistence/atomic-snapshot-writer'

type FsModule = typeof fs
type FsPromisesModule = typeof fsPromises

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<FsModule>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<FsPromisesModule>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

describe('last-status persistence stays off the main thread', () => {
  let userDataPath: string
  let server: AgentHookServer

  const lastStatusPath = (): string => join(userDataPath, 'agent-hooks', 'last-status.json')
  const readPrompt = (): unknown =>
    JSON.parse(readFileSync(lastStatusPath(), 'utf8')).entries[PANE]?.payload?.prompt
  // Exclude synchronous endpoint startup writes from status-persistence checks.
  const statusRenameSyncCalls = (): number =>
    vi.mocked(fs.renameSync).mock.calls.filter(([, to]) => String(to) === lastStatusPath()).length
  const prompt = (text: string): Promise<Response> =>
    postHookEvent(server, buildBody({ hook_event_name: 'UserPromptSubmit', prompt: text }))

  beforeEach(async () => {
    _internals.resetCachesForTests()
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-persist-nonblocking-'))
    server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
  })

  afterEach(() => {
    server.stop()
    vi.mocked(fsPromises.rename).mockReset()
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('keeps answering hooks while a status rename is held open', async () => {
    const actualRename = await vi.importActual<FsPromisesModule>('node:fs/promises')
    let releaseRename: () => void = () => {}
    const renameHeld = new Promise<void>((resolve) => {
      vi.mocked(fsPromises.rename).mockImplementationOnce(async (from, to) => {
        resolve()
        await new Promise<void>((release) => {
          releaseRename = release
        })
        return actualRename.rename(from, to)
      })
    })
    vi.mocked(fsPromises.rename).mockImplementation(actualRename.rename)
    const write = vi.spyOn(AtomicSnapshotWriter.prototype, 'write')
    const writeSync = vi.spyOn(AtomicSnapshotWriter.prototype, 'writeSync')

    expect((await prompt('first')).status).toBe(204)
    await Promise.race([
      renameHeld,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('status write never reached async rename')), 2_000)
      )
    ])

    const timerFired = new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 5))
    expect((await prompt('while renaming')).status).toBe(204)
    expect(await timerFired).toBe(true)
    expect(writeSync).not.toHaveBeenCalled()
    expect(statusRenameSyncCalls()).toBe(0)

    // An older async rename must not undo the synchronous quit flush.
    server.flushStatusPersistSync()
    expect(writeSync).toHaveBeenCalledTimes(1)
    expect(readPrompt()).toBe('while renaming')
    releaseRename()
    await write.mock.results[0]?.value
    expect(readPrompt()).toBe('while renaming')
  })

  it('a burst of status updates never writes synchronously', async () => {
    const writeSync = vi.spyOn(AtomicSnapshotWriter.prototype, 'writeSync')
    for (let i = 0; i < 50; i++) {
      expect((await prompt(`burst ${i}`)).status).toBe(204)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(writeSync).not.toHaveBeenCalled()
    expect(statusRenameSyncCalls()).toBe(0)
  })
})

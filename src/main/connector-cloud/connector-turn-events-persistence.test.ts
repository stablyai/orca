import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as FsPromises from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as OwnerOnlyWrite from '../filesystem/owner-only-durable-file-write'
import { ConnectorTurnEvents } from './connector-turn-events'

// A deliberately slow disk: every write and delete waits for the test to let it through.
const disk = vi.hoisted(() => {
  let held = false
  const waiting: (() => void)[] = []
  return {
    writes: 0,
    deletes: 0,
    failDelete: false,
    failWrites: false,
    hold(): void {
      held = true
    },
    /** Lets the oldest waiting operation through, keeping the rest held. */
    releaseOne: (): void => waiting.shift()?.(),
    release(): void {
      held = false
      waiting.splice(0).forEach((resolve) => resolve())
    },
    wait: (): Promise<void> =>
      held ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve()
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      disk.deletes += 1
      await disk.wait()
      if (disk.failDelete) {
        disk.failDelete = false
        throw Object.assign(new Error('busy'), { code: 'EPERM' })
      }
      return actual.rm(...args)
    }
  }
})

vi.mock('../filesystem/owner-only-durable-file-write', async (importOriginal) => {
  const actual = await importOriginal<typeof OwnerOnlyWrite>()
  return {
    ...actual,
    writeOwnerOnlyFileDurable: async (
      ...args: Parameters<typeof actual.writeOwnerOnlyFileDurable>
    ) => {
      disk.writes += 1
      await disk.wait()
      if (disk.failWrites) {
        throw Object.assign(new Error('full'), { code: 'ENOSPC' })
      }
      return actual.writeOwnerOnlyFileDurable(...args)
    }
  }
})

const conversation = { source: 'slack', externalId: 'T1:C9:1' } as const
const turnEnded = (turnId: number) =>
  ({
    kind: 'turn-ended',
    conversation,
    worktreeId: 'wt',
    paneKey: 'tab:1',
    turnId,
    stopReason: null,
    at: turnId
  }) as const
let userDataPath: string
let outbox: string

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-connector-persistence-'))
  outbox = join(userDataPath, 'connector-turn-outbox.json')
  disk.writes = 0
  disk.deletes = 0
  disk.failDelete = false
  disk.failWrites = false
})

afterEach(async () => {
  disk.failWrites = false
  disk.release()
  await ConnectorTurnEvents.settled()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('ConnectorTurnEvents on a slow disk', () => {
  it('lands a write a newer change overtook, so steady changes still reach the disk', async () => {
    const events = new ConnectorTurnEvents(userDataPath, 'ada')
    disk.hold()
    events.observe(turnEnded(1))
    await vi.waitFor(() => expect(disk.writes).toBe(1))
    events.observe(turnEnded(2))
    disk.releaseOne()
    await vi.waitFor(() => expect(disk.writes).toBe(2))

    const stored: { turnEnds: { turnId: number }[] } = JSON.parse(readFileSync(outbox, 'utf8'))
    expect(stored.turnEnds.map(({ turnId }) => turnId)).toEqual([1])
  })

  it('keeps a sign-out’s delete after it fails, until it lands', async () => {
    const events = new ConnectorTurnEvents(userDataPath, 'ada')
    events.observe(turnEnded(1))
    await ConnectorTurnEvents.settled()
    disk.failDelete = true
    events.clear()
    await vi.waitFor(() => expect(disk.deletes).toBe(1))

    expect(new ConnectorTurnEvents(userDataPath, 'ada').next(1)).toBeNull()
    await ConnectorTurnEvents.settled()
    expect(existsSync(outbox)).toBe(false)
  })

  it('lets quit finish on a failing disk after one more try, keeping the turn ends in memory', async () => {
    const events = new ConnectorTurnEvents(userDataPath, 'ada')
    disk.failWrites = true
    events.observe(turnEnded(1))
    await vi.waitFor(() => expect(disk.writes).toBe(1))
    events.observe(turnEnded(2))
    await vi.waitFor(() => expect(disk.writes).toBe(2))

    await ConnectorTurnEvents.settled()
    expect(new ConnectorTurnEvents(userDataPath, 'ada').next(1)?.batch).toHaveLength(2)
  })

  it('never lets a signed-out account’s queued write bring its turn ends back', async () => {
    const events = new ConnectorTurnEvents(userDataPath, 'ada')
    disk.hold()
    events.observe(turnEnded(1))
    events.clear()
    events.observe(turnEnded(2))
    // Signed straight back in before the disk caught up: nothing of the old session returns.
    expect(new ConnectorTurnEvents(userDataPath, 'ada').next(1)).toBeNull()

    disk.release()
    await ConnectorTurnEvents.settled()
    expect(existsSync(outbox)).toBe(false)
    expect(new ConnectorTurnEvents(userDataPath, 'ada').next(1)).toBeNull()
  })

  it('restores the newest turn ends a restart finds, whatever was still queued', async () => {
    const events = new ConnectorTurnEvents(userDataPath, 'ada')
    disk.hold()
    events.observe(turnEnded(1))
    events.observe(turnEnded(2))
    expect(new ConnectorTurnEvents(userDataPath, 'ada').next(1)?.batch).toEqual([
      expect.objectContaining({ turnId: 1 }),
      expect.objectContaining({ turnId: 2 })
    ])

    disk.release()
    await ConnectorTurnEvents.settled()
    expect(new ConnectorTurnEvents(userDataPath, 'ada').next(1)?.batch).toEqual([
      expect.objectContaining({ turnId: 1 }),
      expect.objectContaining({ turnId: 2 })
    ])
  })
})

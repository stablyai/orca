import * as asyncFs from 'node:fs/promises'
import { installTerminalHistoryIdentity } from '../terminal-history-identity-install'
import { HistoryReader } from '../../restoration/history-reader'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  readdirSync,
  statSync,
  writeFileSync,
  existsSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireOrcadInstanceLock,
  type OrcadInstanceLock
} from '../../../../orcad/orcad-instance-lock'
import { CheckpointSessionQueue } from '../../../providers/checkpointing/daemon-checkpoint-session-queue'
import { HistoryManager } from '../history-manager'
import { DaemonHistoryRetirement } from '../../../providers/adapter/daemon-history-retirement'
import type { TerminalHistoryCheckpointReceipt } from '../terminal-history-root'
import type { TerminalSnapshot } from '../../../protocol/terminal-snapshot'

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof asyncFs>())
}))

const { liveProtocols } = vi.hoisted(() => ({
  liveProtocols: vi.fn(async (): Promise<number[]> => [])
}))
vi.mock('../../../launch/daemon-generation-liveness', () => ({
  listLiveDaemonProtocols: liveProtocols
}))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const snapshot: TerminalSnapshot = {
  snapshotAnsi: 'output received after the caller deadline',
  scrollbackAnsi: '',
  rehydrateSequences: '',
  cwd: '/original',
  cols: 80,
  rows: 24,
  scrollbackLines: 0,
  modes: {
    bracketedPaste: false,
    mouseTracking: false,
    applicationCursor: false,
    alternateScreen: false
  }
}

describe('terminal history migration coordination', () => {
  let dir: string
  let lock: OrcadInstanceLock
  let manager: HistoryManager

  beforeEach(async () => {
    liveProtocols.mockClear()
    liveProtocols.mockResolvedValue([])
    dir = mkdtempSync(join(tmpdir(), 'restore-pty-root-'))
    mkdirSync(join(dir, 'history'))
    mkdirSync(join(dir, 'runtime'))
    lock = acquireOrcadInstanceLock(dir)
    manager = new HistoryManager(join(dir, 'history'))
    manager.identityRoot!.bindProfile(dir, join(dir, 'runtime'), () => [])
    await manager.openSession('9', { cwd: '/original', cols: 80, rows: 24 })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await manager.dispose()
    lock.release()
    rmSync(dir, { recursive: true, force: true })
  })

  it('copies replay bytes into an independent committed identity and keeps the original cwd and history', async () => {
    await manager.checkpoint('9', {
      ...snapshot,
      snapshotAnsi: 'original screen',
      cwd: '/original'
    })
    const root = manager.identityRoot!
    const before = new Map(
      readdirSync(join(root.path, '9')).map((name) => [
        name,
        readFileSync(join(root.path, '9', name))
      ])
    )
    expect(
      await installTerminalHistoryIdentity(
        root,
        '9',
        'scoped-copy',
        { cwd: '/wrong', cols: 40, rows: 12 },
        () => true
      )
    ).toBe('canonical')
    for (const [name, bytes] of before) {
      expect(readFileSync(join(root.path, '9', name))).toEqual(bytes)
      expect(readFileSync(join(root.path, 'scoped-copy', name))).toEqual(bytes)
      expect(statSync(join(root.path, '9', name)).ino).not.toBe(
        statSync(join(root.path, 'scoped-copy', name)).ino
      )
    }
    expect(
      await new HistoryReader(root.path).detectColdRestore('scoped-copy', { ignoreCleanEnd: true })
    ).toMatchObject({ cwd: '/original' })
    expect(readdirSync(root.path).filter((name) => name.startsWith('.identity-copy-'))).toEqual([])
  })

  it('keeps incomplete or unsafe recovery in place, and never falls back from committed canonical metadata', async () => {
    const root = manager.identityRoot!
    mkdirSync(join(root.path, 'partial'))
    writeFileSync(join(root.path, 'partial/output.log'), 'unknown partial bytes')
    expect(
      await installTerminalHistoryIdentity(
        root,
        '9',
        'partial',
        { cwd: '/original', cols: 80, rows: 24 },
        () => true
      )
    ).toBe('legacy')
    expect(readFileSync(join(root.path, 'partial/output.log'), 'utf8')).toBe(
      'unknown partial bytes'
    )
    writeFileSync(join(root.path, '9/unknown-file'), 'retained')
    expect(
      await installTerminalHistoryIdentity(
        root,
        '9',
        'unsafe-copy',
        { cwd: '/original', cols: 80, rows: 24 },
        () => true
      )
    ).toBe('legacy')
    expect(existsSync(join(root.path, 'unsafe-copy/meta.json'))).toBe(false)
    writeFileSync(join(root.path, 'partial/meta.json'), 'unreadable committed metadata')
    expect(
      await installTerminalHistoryIdentity(
        root,
        '9',
        'partial',
        { cwd: '/original', cols: 80, rows: 24 },
        () => false
      )
    ).toBe('canonical')
    expect(readFileSync(join(root.path, 'partial/meta.json'), 'utf8')).toBe(
      'unreadable committed metadata'
    )
  })

  it('lets a new numeric admission cancel conversion while preserving ordinary source writes', async () => {
    const root = manager.identityRoot!
    const hold = deferred()
    const outstanding = root.observeWork('9', () => hold.promise)
    const copying = installTerminalHistoryIdentity(
      root,
      '9',
      'canceled-copy',
      { cwd: '/original', cols: 80, rows: 24 },
      () => true
    )
    const finishAdmission = root.observeNumeric('9', true)
    hold.resolve()
    await outstanding
    expect(await copying).toBe('legacy')
    finishAdmission(false)
    expect(await manager.checkpoint('9', snapshot)).toBe('committed')
    expect(existsSync(join(root.path, 'canceled-copy/meta.json'))).toBe(false)
  })

  it('drains an abandoned checkpoint before freezing, and revokes its completion authority', async () => {
    vi.useFakeTimers()
    const root = manager.identityRoot!
    const queue = new CheckpointSessionQueue(root)
    const reply = deferred()
    let receipt: TerminalHistoryCheckpointReceipt | undefined
    const caller = queue.runWithDeadline(
      '9',
      async (admitted) => {
        receipt = admitted
        await reply.promise
        await manager.checkpoint('9', snapshot, undefined, admitted)
        return 'done'
      },
      5,
      'deadline'
    )
    await vi.advanceTimersByTimeAsync(5)
    expect(await caller).toBe('deadline')
    const migration = root.beginMigration(['9', 'scoped-first'], () => true)
    reply.resolve()
    const lease = await migration
    expect(lease?.current()).toBe(true)
    expect(readFileSync(join(dir, 'history/9/checkpoint.json'), 'utf8')).toContain(
      'output received after the caller deadline'
    )
    lease!.release()

    const later = await root.beginMigration(['9', 'scoped-later'], () => true)
    expect(later?.current()).toBe(true)
    expect(
      await manager.checkpoint(
        '9',
        { ...snapshot, snapshotAnsi: 'new legitimate output' },
        undefined,
        receipt
      )
    ).toBe('committed')
    expect(later!.current()).toBe(false)
    expect(readFileSync(join(dir, 'history/9/checkpoint.json'), 'utf8')).toContain(
      'new legitimate output'
    )
  })

  it('keeps another adapter progressing and its writer usable when an equal-number owner stalls or detaches', async () => {
    const root = manager.identityRoot!
    const other = new HistoryManager(join(dir, 'history'), { resizeModel: () => 'other-host' })
    await other.registerWriter('9')
    const stalled = deferred()
    const first = root.observeWork('9', () => stalled.promise)
    try {
      expect(await root.observeWork('9', () => other.checkpoint('9', snapshot))).toBe('committed')
      await manager.releaseIdentity('detach')
      expect(await other.checkpoint('9', { ...snapshot, snapshotAnsi: 'surviving adapter' })).toBe(
        'committed'
      )
      expect(readFileSync(join(dir, 'history/9/checkpoint.json'), 'utf8')).toContain(
        'surviving adapter'
      )
      expect(JSON.parse(readFileSync(join(dir, 'history/9/meta.json'), 'utf8')).resizeModel).toBe(
        'other-host'
      )
    } finally {
      stalled.resolve()
      await first
      await other.releaseIdentity('detach')
    }
  })

  it('lets a successor cold reader see a retiring producer that outlived its caller', async () => {
    const queue = new CheckpointSessionQueue()
    const gate = deferred()
    const entered = deferred()
    const order: string[] = []
    const tail = queue.run('9', async (receipt) => {
      entered.resolve()
      await gate.promise
      await manager.checkpoint(
        '9',
        { ...snapshot, snapshotAnsi: 'retired producer final screen' },
        undefined,
        receipt
      )
      order.push('old producer durable')
    })
    await entered.promise
    manager.retireIdentity((id) => queue.captureTail(id))
    const successor = new HistoryManager(manager.identityRoot!.path)
    try {
      const freeze = successor.freezeForRecovery('9').then((value) => {
        order.push('successor frozen')
        return value
      })
      gate.resolve()
      await tail
      const receipt = await freeze
      expect(order).toEqual(['old producer durable', 'successor frozen'])
      const recovered = await new HistoryReader(manager.identityRoot!.path).detectColdRestore('9', {
        ignoreCleanEnd: true
      })
      expect(recovered?.snapshotAnsi).toContain('retired producer final screen')
      successor.abandonRecoveryFreeze(receipt)
    } finally {
      gate.resolve()
      await queue.drain()
      await successor.releaseIdentity('detach')
    }
  })

  it('retains recovered history after a real root freeze thaws the captured old writer', async () => {
    await manager.identityRoot!.profileReady()
    await manager.checkpoint('9', snapshot)
    const writer = manager.captureWriter('9')!
    const retirement = new DaemonHistoryRetirement(
      '11111111-1111-4111-8111-111111111111',
      { pid: 1, startedAtMs: 1, launchNonce: 'history-test-owner' },
      manager,
      '9',
      writer,
      new CheckpointSessionQueue(),
      () => {}
    )
    const migration = await manager.identityRoot!.beginMigration(['9'], () => true)
    try {
      expect(migration).not.toBeNull()
      expect(manager.hasWriter('9')).toBe(false)
    } finally {
      migration?.release()
    }
    expect(manager.captureWriter('9')).toBe(writer)
    retirement.removeHistory()
    await retirement.finish(true)
    expect(manager.hasWriter('9')).toBe(false)
    expect(
      await new HistoryReader(manager.identityRoot!.path).detectColdRestore('9')
    ).toMatchObject({ snapshotAnsi: 'output received after the caller deadline' })
  })

  it.each(['directory', 'linked-file'] as const)(
    'cleans only its own incomplete target after cancellation at %s, then retries once',
    async (phase) => {
      const root = manager.identityRoot!
      await manager.checkpoint('9', snapshot)
      const target = join(root.path, 'workspace%40%40cancelled')
      const cancel = new AbortController()
      const originalMkdir = asyncFs.mkdir
      const originalLink = asyncFs.link
      const mkdir = vi.spyOn(asyncFs, 'mkdir').mockImplementation(async (...args) => {
        const result = await originalMkdir(...args)
        if (phase === 'directory' && args[0] === target) {
          cancel.abort()
        }
        return result
      })
      const link = vi.spyOn(asyncFs, 'link').mockImplementation(async (...args) => {
        await originalLink(...args)
        if (phase === 'linked-file' && String(args[1]).startsWith(target)) {
          cancel.abort()
        }
      })
      try {
        expect(
          await installTerminalHistoryIdentity(
            root,
            '9',
            'workspace@@cancelled',
            { cwd: '/original', cols: 80, rows: 24 },
            () => true,
            cancel.signal
          )
        ).toBe('legacy')
        expect(existsSync(target)).toBe(false)
        expect(readFileSync(join(root.path, '9/checkpoint.json'), 'utf8')).toContain(
          'output received after the caller deadline'
        )
      } finally {
        mkdir.mockRestore()
        link.mockRestore()
      }
      expect(
        await installTerminalHistoryIdentity(
          root,
          '9',
          'workspace@@cancelled',
          { cwd: '/original', cols: 80, rows: 24 },
          () => true
        )
      ).toBe('canonical')
      const entries = readdirSync(root.path).sort()
      expect(entries).toEqual(['9', 'workspace%40%40cancelled'])
      expect(
        await installTerminalHistoryIdentity(
          root,
          '9',
          'workspace@@cancelled',
          { cwd: '/original', cols: 80, rows: 24 },
          () => true
        )
      ).toBe('canonical')
      expect(readdirSync(root.path).sort()).toEqual(entries)
    }
  )

  it('keeps migration unavailable when a surviving old host omits reservation facts', async () => {
    liveProtocols.mockResolvedValue([55])
    const root = manager.identityRoot!
    const unregister = root.registerHost({
      protocolVersion: 55,
      reservations: async () => undefined
    })
    try {
      expect(await root.beginMigration(['9', 'scoped'], () => true)).toBeNull()
      expect(await manager.checkpoint('9', snapshot)).toBe('committed')
    } finally {
      unregister()
    }
  })

  it.each([10, 100])(
    'shares one reservation census across %i cold selections until authority changes',
    async (count) => {
      liveProtocols.mockResolvedValue([55])
      const root = manager.identityRoot!
      const reservations = vi.fn(async () => ({
        complete: true as const,
        authorityGeneration: 'first-host',
        sessionIds: Array<string>()
      }))
      let unregister = root.registerHost({ protocolVersion: 55, reservations })
      try {
        for (let index = 0; index < count; index += 1) {
          const lease = await root.beginMigration(
            [String(index), `workspace@@${index}`],
            () => true
          )
          expect(lease?.current()).toBe(true)
          lease!.release()
        }
        // One authoritative inventory serves every absent ID in this epoch.
        expect(reservations).toHaveBeenCalledTimes(1)
        expect(liveProtocols).toHaveBeenCalledTimes(1)

        root.observeNumeric('9', true)(false)
        expect(await root.beginMigration(['9', 'workspace@@later'], () => true)).toBeNull()
        expect(reservations).toHaveBeenCalledTimes(1)

        unregister()
        unregister = root.registerHost({ protocolVersion: 55, reservations })
        const next = await root.beginMigration(['200', 'workspace@@next'], () => true)
        expect(next?.current()).toBe(true)
        next!.release()
        expect(reservations).toHaveBeenCalledTimes(2)
        expect(liveProtocols).toHaveBeenCalledTimes(2)
      } finally {
        unregister()
      }
    }
  )
})

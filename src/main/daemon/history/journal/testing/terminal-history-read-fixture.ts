import { mkdirSync, mkdtempSync, promises as fsPromises, rmSync } from 'node:fs'
import { vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrioritySemaphore } from '../../../../../shared/priority-semaphore'
import { TerminalSessionJournal } from '../terminal-session-journal'
import { DerivedHistoryImageBudget } from '../terminal-history-derived-image'
import { TerminalHistoryReads } from '../terminal-history-read-admission'
import { getHistorySessionDirName } from '../../storage/history-paths'

const roots: string[] = []

/** Removes the temporary roots the fixture created. */
export function removeReadFixtureRoots(): void {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
}

export function openReads(imageBudget?: number) {
  const replay = new PrioritySemaphore(1)
  const images = new DerivedHistoryImageBudget(imageBudget)
  const reads = new TerminalHistoryReads(() => true, images)
  const root = mkdtempSync(join(tmpdir(), 'orca-read-flight-'))
  roots.push(root)
  let sequence = 0
  const openJournal = (sessionId: string): TerminalSessionJournal => {
    const dirName = getHistorySessionDirName(sessionId)
    mkdirSync(join(root, dirName), { recursive: true })
    const journal = new TerminalSessionJournal(
      {
        acquireReplay: (priority, signal) => replay.acquire(priority, signal),
        images,
        charge: () => {},
        makeRoom: () => {},
        settled: () => {},
        log: () => {}
      },
      root,
      dirName,
      { cwd: '/tmp', cols: 80, rows: 24, wslDistro: undefined, preservesRecovery: false }
    )
    journal.bindSession({
      incarnationId: `${sessionId}-incarnation`,
      historySeeded: undefined,
      isAlive: true,
      settleShellOwnershipConfirmation: async () => {},
      snapshotBarrier: () => {},
      prepareForFinalSnapshot: () => ''
    })
    journal.bindOutput({
      outputSequence: () => sequence,
      terminalOwner: () => undefined,
      hasAttachedClient: () => false
    })
    return journal
  }
  const record = (journal: TerminalSessionJournal, data: string): void => {
    sequence += data.length
    journal.record({ kind: 'output', data })
  }
  // An opened origin with an empty queue, so later output stays pending in its append window.
  const prime = async (journal: TerminalSessionJournal): Promise<void> => {
    record(journal, 'PRIME\r\n')
    await journal.flush()
  }
  const rows = (marker: string, count: number): string =>
    Array.from(
      { length: count },
      (_, i) => `${marker}_${String(i).padStart(4, '0')}${'.'.repeat(60)}\r\n`
    ).join('')
  return { reads, replay, images, openJournal, record, prime, rows }
}

/** One consumer's whole read, as a deep snapshot route performs it. */
export async function readDeep(
  reads: TerminalHistoryReads,
  journal: TerminalSessionJournal,
  signal = new AbortController().signal,
  barrier: () => Promise<void> = async () => {}
): Promise<string | null> {
  const consumer = reads.admit(signal)!
  try {
    const found = await consumer.acquire(journal, 5000, barrier)
    const ready =
      found === 'image' ||
      (found !== null && found.capture() && (await consumer.awaitFlight(found)))
    const image = consumer.image
    return ready && image ? `${image.snapshot.scrollbackAnsi}${image.snapshot.snapshotAnsi}` : null
  } catch {
    return null
  } finally {
    consumer.release()
  }
}

/** Holds this journal's reconstructions until released, counting them. */
export function gateReconstruction(journal: TerminalSessionJournal) {
  let gate = Promise.withResolvers<void>()
  const readImage = journal.readImage.bind(journal)
  const calls = vi.spyOn(journal, 'readImage').mockImplementation(async (...args) => {
    await gate.promise
    return readImage(...args)
  })
  return {
    calls,
    open: () => gate.resolve(),
    close: () => {
      gate = Promise.withResolvers<void>()
    }
  }
}

/** Holds every log append until released; pending output stays queued meanwhile. */
export function gateAppends() {
  let gate = Promise.withResolvers<void>()
  const appendFile = fsPromises.appendFile
  vi.spyOn(fsPromises, 'appendFile').mockImplementation(async (...args) => {
    await gate.promise
    return appendFile(...args)
  })
  return {
    open: () => gate.resolve(),
    close: () => {
      gate = Promise.withResolvers<void>()
    }
  }
}

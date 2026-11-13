import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { Session } from '../session'
import { HistoryReader } from '../../history/restoration/history-reader'
import { _resetPtyOwnerHostColorsForTest } from '../../../../shared/terminal/pty/ingress/pty-owner-color-query-colors'
import {
  openReads,
  removeReadFixtureRoots
} from '../../history/journal/testing/terminal-history-read-fixture'

afterEach(() => {
  vi.restoreAllMocks()
  removeReadFixtureRoots()
  _resetPtyOwnerHostColorsForTest()
})

function createSubprocess() {
  let onData: ((data: string) => void) | null = null
  let onExit: ((code: number) => void) | null = null
  return {
    pid: 12345,
    getForegroundProcess: (): string | null => null,
    confirmShellForeground: vi.fn(async () => true),
    write: () => {},
    resize: () => {},
    pause: () => {},
    resume: () => {},
    kill: () => {},
    terminateOwnedTree: () => 'terminated' as const,
    forceKill: () => {},
    signal: () => {},
    onData(cb: (data: string) => void) {
      onData = cb
    },
    onExit(cb: (code: number) => void) {
      onExit = cb
    },
    dispose: () => {},
    simulateData: (data: string) => onData?.(data),
    simulateExit: (code: number) => onExit?.(code)
  }
}

describe('a Sleep final cut from physical exit', () => {
  // Held startup bytes and pending parser work must both be in F, even when reaping is immediate.
  it('publishes held output and its final position though the Session is reaped at exit', async () => {
    const { openJournal } = openReads()
    const journal = openJournal('physical-final')
    const subprocess = createSubprocess()
    const session = new Session({
      sessionId: 'physical-final',
      cols: 80,
      rows: 24,
      subprocess,
      shellReadySupported: false,
      ownerBackend: 'windows-conpty',
      startupIngress: {
        colors: { foreground: '#2e3434', background: '#ffffff' },
        deadlineMs: 5_000
      },
      historyJournal: journal
    })
    journal.bindSession(session)
    subprocess.simulateData('VISIBLE_ROW\r\n')
    const sleep = journal.admitOperation('sleep', '/tmp/folder-b')
    if (typeof sleep === 'string') {
      throw new Error(sleep)
    }
    expect(await journal.preflightSleep(sleep)).toBe(true)
    // The startup ingress holds this cooked echo until it can tell it from a reply.
    subprocess.simulateData('\x1b]10;?\x07')
    subprocess.simulateData(']10;rgb:2e2e/')
    expect(session.beginTermination(() => journal.authorizeSleep(sleep))).toBe(true)
    // Input-mode grounding is parser work still pending when the process exits.
    session.resetInputModes()
    const exits: number[] = []
    session.attachClient({ onData: () => {}, onExit: (code) => exits.push(code) })
    let settled = false
    void sleep.outcome.promise.then(() => (settled = true))

    subprocess.simulateExit(0)
    session.dispose()

    // Exit is reported at once; the final publication finishes afterwards, off that path.
    expect(exits).toEqual([0])
    expect(settled).toBe(false)
    const receipt = await sleep.outcome.promise
    expect(receipt).toMatchObject({
      backing: 'checkpoint',
      outputSequence: 'VISIBLE_ROW\r\n\x1b]10;?\x07]10;rgb:2e2e/'.length
    })
    const restored = await new HistoryReader(join(journal.dir, '..')).detectColdRestore(
      'physical-final'
    )
    expect(restored?.cwd).toBe('/tmp/folder-b')
    expect(restored?.snapshotAnsi).toContain('VISIBLE_ROW')
    expect(restored?.snapshotAnsi).toContain(']10;rgb:2e2e/')
  })
})

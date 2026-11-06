import { afterEach, describe, expect, it } from 'vitest'
import { Session } from '../session'

function createMockSubprocess() {
  let onData: ((data: string) => void) | null = null
  return {
    pid: 12345,
    getForegroundProcess: (): string | null => null,
    write(_data: string) {},
    resize(_cols: number, _rows: number) {},
    kill() {},
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill() {},
    signal(_sig: string) {},
    onData(cb: (data: string) => void) {
      onData = cb
    },
    onExit(_cb: (code: number) => void) {},
    dispose() {},
    simulateData(data: string) {
      onData?.(data)
    }
  }
}

let session: Session | null = null

afterEach(() => {
  session?.dispose()
  session = null
})

function createSession(subprocess = createMockSubprocess()): Session {
  session = new Session({
    sessionId: 'pending-test',
    cols: 80,
    rows: 24,
    subprocess,
    shellReadySupported: false
  })
  return session
}

describe('Session pending output', () => {
  it('records output, resize, and clear in application order', () => {
    const subprocess = createMockSubprocess()
    const live = createSession(subprocess)

    subprocess.simulateData('before resize')
    live.resize(100, 30)
    subprocess.simulateData('after resize')
    live.clearScrollback()

    const take = live.takePendingOutput(false)
    expect(take).not.toBeNull()
    expect(take!.overflowed).toBe(false)
    expect(take!.snapshot).toBeNull()
    expect(take!.records).toEqual([
      { kind: 'output', data: 'before resize' },
      { kind: 'resize', cols: 100, rows: 30 },
      { kind: 'output', data: 'after resize' },
      { kind: 'clear' }
    ])
  })

  it('returns the snapshot and drops records in the same take when requested', () => {
    const subprocess = createMockSubprocess()
    const live = createSession(subprocess)

    subprocess.simulateData('snapshot content\r\n')
    const take = live.takePendingOutput(true)
    expect(take!.records).toEqual([])
    expect(take!.snapshot?.snapshotAnsi).toContain('snapshot content')

    // Snapshot-covered records must not replay again on recovery.
    const next = live.takePendingOutput(false)
    expect(next!.records).toEqual([])
  })
})

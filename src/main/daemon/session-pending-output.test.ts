import { afterEach, describe, expect, it } from 'vitest'
import { Session } from './session'

// Coverage for the incremental-checkpoint record stream (issue #5096): every
// PTY byte, resize, and clear is recorded so the 5s checkpoint can persist
// increments without serializing the emulator.

function createMockSubprocess() {
  let onData: ((data: string) => void) | null = null
  return {
    pid: 12345,
    getForegroundProcess: (): string | null => null,
    write(_data: string) {},
    resize(_cols: number, _rows: number) {},
    kill() {},
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

  it('coalesces adjacent output chunks', () => {
    const subprocess = createMockSubprocess()
    const live = createSession(subprocess)

    for (let i = 0; i < 100; i += 1) {
      subprocess.simulateData(`chunk-${i};`)
    }

    const take = live.takePendingOutput(false)
    expect(take!.records).toHaveLength(1)
    expect(take!.records[0]).toMatchObject({ kind: 'output' })
  })

  it('drains on take and increments the batch sequence', () => {
    const subprocess = createMockSubprocess()
    const live = createSession(subprocess)

    subprocess.simulateData('first')
    const first = live.takePendingOutput(false)
    expect(first!.records).toEqual([{ kind: 'output', data: 'first' }])

    subprocess.simulateData('second')
    const second = live.takePendingOutput(false)
    expect(second!.records).toEqual([{ kind: 'output', data: 'second' }])
    expect(second!.seq).toBe(first!.seq + 1)

    const empty = live.takePendingOutput(false)
    expect(empty!.records).toEqual([])
  })

  it('flags overflow past the cap and recovers after a take', () => {
    const subprocess = createMockSubprocess()
    const live = createSession(subprocess)

    const megabyte = 'x'.repeat(1024 * 1024)
    subprocess.simulateData(megabyte)
    subprocess.simulateData(megabyte)
    subprocess.simulateData(megabyte)

    const overflowed = live.takePendingOutput(false)
    expect(overflowed!.overflowed).toBe(true)
    expect(overflowed!.records).toEqual([])

    subprocess.simulateData('post-overflow')
    const recovered = live.takePendingOutput(false)
    expect(recovered!.overflowed).toBe(false)
    expect(recovered!.records).toEqual([{ kind: 'output', data: 'post-overflow' }])
  })

  it('returns the snapshot and drops records in the same take when requested', () => {
    const subprocess = createMockSubprocess()
    const live = createSession(subprocess)

    subprocess.simulateData('snapshot content\r\n')
    const take = live.takePendingOutput(true)
    expect(take!.records).toEqual([])
    expect(take!.snapshot?.snapshotAnsi).toContain('snapshot content')

    // Records taken alongside the snapshot must not reappear later — they are
    // already part of the snapshot and would replay twice on cold restore.
    const next = live.takePendingOutput(false)
    expect(next!.records).toEqual([])
  })

  it('returns null after dispose', () => {
    const live = createSession()
    live.dispose()
    expect(live.takePendingOutput(false)).toBeNull()
  })
})

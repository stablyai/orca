import { expect, it } from 'vitest'
import { HeadlessEmulator } from './headless-emulator'
import { SessionOutputPlane } from './session-output-plane'
import { RecentPtyOutputBuffer } from '../runtime/recent-pty-output-buffer'

it('retains a persistent header after redraw traffic outgrows the relay replay tail', async () => {
  const dimensions = { cols: 80, rows: 24 }
  const plane = new SessionOutputPlane(dimensions)
  const rawTail = new RecentPtyOutputBuffer({ limit: 100 * 1024 })
  const fromTail = new HeadlessEmulator(dimensions)
  const fromSnapshot = new HeadlessEmulator(dimensions)
  let sequence = 0
  const emit = (data: string): void => {
    const start = sequence
    sequence += data.length
    rawTail.append(data)
    plane.emit({ data, rawStartSeq: start, rawEndSeq: sequence, transformed: false })
  }
  try {
    emit('\x1b[2J\x1b[HIMPORTANT HEADER\x1b[2;1H')
    for (let frame = 0; frame < 12_000; frame++) {
      emit(`\r\x1b[2Kprogress ${frame}`)
    }
    expect(sequence).toBeGreaterThan(100 * 1024)
    await plane.flushParsedWrites()
    const snapshot = plane.getSnapshot()
    expect(snapshot).not.toBeNull()
    if (!snapshot) {
      throw new Error('Expected an owner snapshot')
    }
    await fromTail.write(rawTail.read())
    await fromSnapshot.write(
      snapshot.scrollbackAnsi + snapshot.rehydrateSequences + snapshot.snapshotAnsi
    )
    expect(fromTail.getVisibleLines().join('\n')).not.toContain('IMPORTANT HEADER')
    expect(fromSnapshot.getVisibleLines()[0]).toContain('IMPORTANT HEADER')
    expect(fromSnapshot.getVisibleLines()[1]).toContain('progress 11999')
    expect(snapshot.outputSequence).toBe(sequence)
    emit(' LIVE')
    await plane.flushParsedWrites()
    await fromSnapshot.write(' LIVE')
    expect(fromSnapshot.getVisibleLines()[1]).toContain('progress 11999 LIVE')
    expect(plane.getSnapshot()?.outputSequence).toBe(sequence)
  } finally {
    plane.markDisposed()
    plane.disposeEmulator()
    fromTail.dispose()
    fromSnapshot.dispose()
  }
})

import { describe, expect, it, vi } from 'vitest'
import { deepenHeadlessCopyToDesktopDepth } from './headless-copy-desktop-depth'

function source(desktop: { data: string; seq?: number } | null, outputSequences = [7, 7]) {
  const sequences = [...outputSequences]
  return {
    getPtyOutputSequence: vi.fn(() => sequences.shift() ?? 7),
    serializeRendererTerminalBuffer: vi.fn(async () =>
      desktop ? { ...desktop, cols: 80, rows: 24 } : null
    ),
    replaceHeadlessTerminalFromRendererSnapshotForRecovery: vi.fn()
  }
}

describe('deepenHeadlessCopyToDesktopDepth', () => {
  it('re-seeds main from a desktop-depth read of the same sequence', async () => {
    const runtime = source({ data: 'all 1500 rows', seq: 7 })
    await expect(
      deepenHeadlessCopyToDesktopDepth(runtime, 'pty-1', { seq: 7 }, () => true)
    ).resolves.toBe(true)
    expect(runtime.serializeRendererTerminalBuffer).toHaveBeenCalledWith('pty-1', {
      scrollbackRows: 5000
    })
    expect(runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery).toHaveBeenCalledWith(
      'pty-1',
      expect.objectContaining({ data: 'all 1500 rows' })
    )
  })

  it.each([
    ['output already followed the phone snapshot', source({ data: 'x', seq: 7 }, [8])],
    ['the renderer moved past the phone snapshot', source({ data: 'newer', seq: 8 })],
    ['output arrived during the read', source({ data: 'raced', seq: 7 }, [7, 8])],
    ['the renderer has nothing to serialize', source(null)]
  ])('leaves main alone when %s', async (_case, runtime) => {
    await expect(
      deepenHeadlessCopyToDesktopDepth(runtime, 'pty-1', { seq: 7 }, () => true)
    ).resolves.toBe(false)
    expect(runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery).not.toHaveBeenCalled()
  })

  it('leaves main alone once the subscription closed or without a sequence', async () => {
    const runtime = source({ data: 'all', seq: 7 })
    await deepenHeadlessCopyToDesktopDepth(runtime, 'pty-1', { seq: 7 }, () => false)
    await deepenHeadlessCopyToDesktopDepth(runtime, 'pty-1', {}, () => true)
    expect(runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery).not.toHaveBeenCalled()
  })
})

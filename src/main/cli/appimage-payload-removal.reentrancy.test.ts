import { afterEach, describe, expect, it, vi } from 'vitest'

// Why a mocked rm: the property under test is the ORDER in which overlapping removals settle, which
// real filesystem timing cannot pin down. Deferreds make the interleaving exact.
const { rmMock } = vi.hoisted(() => ({ rmMock: vi.fn() }))
vi.mock('node:fs/promises', () => ({ rm: rmMock }))

const originalNoAsar = process.noAsar

afterEach(() => {
  process.noAsar = originalNoAsar
  vi.resetModules()
})

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('removeExtractedAppImagePayload reentrancy', () => {
  // The hazard is the FIRST removal settling while a later one is still running: a naive
  // save/restore would hand the shim back and silently leak the rest of the second removal.
  it('keeps asar interception disabled while a later removal is still running', async () => {
    process.noAsar = false
    const first = deferred()
    const second = deferred()
    rmMock.mockReset()
    rmMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { removeExtractedAppImagePayload } = await import('./appimage-payload-removal')

    const firstCall = removeExtractedAppImagePayload('/cache/gen-a')
    const secondCall = removeExtractedAppImagePayload('/cache/gen-b')
    expect(process.noAsar).toBe(true)

    first.resolve()
    await firstCall
    // gen-b is still being removed: handing the shim back here is exactly the leak.
    expect(process.noAsar).toBe(true)

    second.resolve()
    await secondCall
    expect(process.noAsar).toBe(false)
  })

  it('keeps the flag held when the first removal rejects mid-overlap', async () => {
    process.noAsar = false
    const second = deferred()
    rmMock.mockReset()
    rmMock.mockRejectedValueOnce(new Error('EACCES')).mockReturnValueOnce(second.promise)
    const { removeExtractedAppImagePayload } = await import('./appimage-payload-removal')

    const firstCall = removeExtractedAppImagePayload('/cache/gen-a')
    const secondCall = removeExtractedAppImagePayload('/cache/gen-b')

    await expect(firstCall).rejects.toThrow('EACCES')
    expect(process.noAsar).toBe(true)

    second.resolve()
    await secondCall
    expect(process.noAsar).toBe(false)
  })
})

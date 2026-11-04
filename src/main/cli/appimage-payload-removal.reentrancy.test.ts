import { afterEach, describe, expect, it, vi } from 'vitest'

// Deferred removals make overlap ordering deterministic.
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

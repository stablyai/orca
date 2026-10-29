import { afterEach, describe, expect, it, vi } from 'vitest'

const readFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:fs/promises', () => ({ readFile: readFileMock }))

afterEach(() => {
  vi.resetModules()
  readFileMock.mockReset()
})

describe('Grok auth snapshot', () => {
  it('redacts denied filesystem paths from public state', async () => {
    readFileMock.mockRejectedValue(
      Object.assign(new Error('open /Users/private/.grok/auth.json'), { code: 'EACCES' })
    )
    const snapshot = await import('./grok-auth-snapshot')

    await snapshot.refreshGrokAuthSnapshot()

    expect(snapshot.getGrokAuthSnapshot()).toMatchObject({
      value: null,
      stale: true,
      availability: 'denied'
    })
    expect(JSON.stringify(snapshot.getGrokAuthSnapshot())).not.toContain('/Users/private')
  })

  it('coalesces concurrent refreshes', async () => {
    readFileMock.mockResolvedValue('{}')
    const snapshot = await import('./grok-auth-snapshot')

    await Promise.all([snapshot.refreshGrokAuthSnapshot(), snapshot.refreshGrokAuthSnapshot()])

    expect(readFileMock).toHaveBeenCalledTimes(1)
  })
})

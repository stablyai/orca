import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const { scan } = vi.hoisted(() => ({ scan: vi.fn() }))
vi.mock('./fs-list-files-fallback-chain', () => ({ runListFilesScan: scan }))
vi.mock('@parcel/watcher', () => ({ subscribe: vi.fn() }))
import { createRelayFileListingRequestHarness } from './fs-list-files-dispatch-test-harness'
let harness: ReturnType<typeof createRelayFileListingRequestHarness>
beforeEach(() => {
  scan.mockReset().mockResolvedValue([])
  harness = createRelayFileListingRequestHarness()
})
afterEach(() => harness.dispose())
it('routes validated candidates and both discovery options from wire dispatch into the scan', async () => {
  await harness.request({
    rootPath: '/root',
    candidatePaths: ['late.ts', 'late.ts', '../escape'],
    includeIgnored: false,
    followSymlinks: true,
    maxResults: 1
  })
  expect(scan).toHaveBeenCalledWith('/root', [], expect.any(AbortSignal), 1, undefined, {
    candidatePaths: ['late.ts'],
    includeIgnored: false,
    followSymlinks: true
  })
})
it.each([null, 42, ['valid.ts', 1]])(
  'rejects malformed candidates %j before scanning',
  async (candidatePaths) => {
    await expect(harness.request({ rootPath: '/root', candidatePaths })).rejects.toThrow(
      'Invalid Quick Open'
    )
    expect(scan).not.toHaveBeenCalled()
  }
)
it('rejects an over-count candidate set before scanning', async () => {
  await expect(
    harness.request({
      rootPath: '/root',
      candidatePaths: Array.from({ length: 101 }, (_, i) => `${i}.ts`)
    })
  ).rejects.toThrow('Too many')
  expect(scan).not.toHaveBeenCalled()
})
it('rejects an over-byte candidate before scanning', async () => {
  await expect(
    harness.request({ rootPath: '/root', candidatePaths: ['x'.repeat(65_537)] })
  ).rejects.toThrow('too large')
  expect(scan).not.toHaveBeenCalled()
})
it('keeps distinct candidate sets from coalescing and stops the superseded scan', async () => {
  scan.mockImplementation(
    (
      _root,
      _excluded,
      signal: AbortSignal,
      _limit,
      _query,
      options: { candidatePaths: string[] }
    ) =>
      options.candidatePaths[0] === 'a.ts'
        ? new Promise<string[]>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
        : Promise.resolve(options.candidatePaths)
  )
  const first = harness.request({ rootPath: '/root', candidatePaths: ['a.ts'], maxResults: 1 })
  const rejected = expect(first).rejects.toThrow('superseded')
  await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce())
  await expect(
    harness.request({ rootPath: '/root', candidatePaths: ['b.ts'], maxResults: 1 })
  ).resolves.toEqual(['b.ts'])
  await rejected
  expect(scan).toHaveBeenCalledTimes(2)
  expect(scan.mock.calls[0][2].aborted).toBe(true)
})
it('coalesces matching candidate sets and preserves omitted candidates for old callers', async () => {
  let release = (): void => {
    throw new Error('Scan not started')
  }
  scan.mockReturnValue(
    new Promise<string[]>((resolve) => {
      release = () => resolve(['a.ts'])
    })
  )
  const params = { rootPath: '/root', candidatePaths: ['a.ts'], maxResults: 1 }
  const first = harness.request(params)
  const second = harness.request(params)
  await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce())
  release()
  expect(await first).toEqual(['a.ts'])
  expect(await second).toEqual(['a.ts'])
  expect(scan).toHaveBeenCalledOnce()
  scan.mockResolvedValueOnce([])
  await harness.request({ rootPath: '/root' })
  expect(scan.mock.calls[1][5]).toEqual({})
})

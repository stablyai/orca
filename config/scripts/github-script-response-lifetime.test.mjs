import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { listPullFiles, updatePullRequest } from '../../.github/scripts/pr-test-loc-summary.mjs'

const pullOptions = {
  owner: 'example',
  repo: 'example',
  pullNumber: 9,
  token: 'test-token',
  totals: {
    test: { files: 1, added: 2, deleted: 0 },
    nonTest: { files: 0, added: 0, deleted: 0 }
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

function responseOwner() {
  const active = new Set()
  let cancellations = 0
  onTestFinished(() => {
    for (const controller of active) {
      controller.close()
    }
    active.clear()
  })
  return {
    active,
    get cancellations() {
      return cancellations
    },
    response(status, rejectCancel = false) {
      let controller
      const body = new ReadableStream({
        start(value) {
          controller = value
          active.add(controller)
          controller.enqueue(new Uint8Array([1]))
        },
        cancel() {
          cancellations += 1
          active.delete(controller)
          if (rejectCancel) {
            return Promise.reject(new Error('cancel failed'))
          }
        }
      })
      return new Response(body, { status, statusText: `status ${status}` })
    }
  }
}

it.each([403, 404, 500])('releases failed PR file responses (%i)', async (status) => {
  const owner = responseOwner()
  for (let cycle = 0; cycle < 30; cycle += 1) {
    await expect(
      listPullFiles({ ...pullOptions, fetchImpl: async () => owner.response(status) })
    ).rejects.toThrow(`Failed to list PR #9 files: ${status} status ${status}`)
  }
  expect(owner.active.size).toBe(0)
  expect(owner.cancellations).toBe(30)
})

it.each([403, 404])('releases unread PR lookup responses (%i)', async (status) => {
  const owner = responseOwner()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  for (let cycle = 0; cycle < 30; cycle += 1) {
    const result = updatePullRequest({
      ...pullOptions,
      fetchImpl: async () => owner.response(status)
    })
    await (status === 403
      ? expect(result).resolves.toBe(0)
      : expect(result).rejects.toThrow(`Failed to read PR #9: ${status} status ${status}`))
  }
  expect(owner.active.size).toBe(0)
  expect(owner.cancellations).toBe(30)
})

it.each([200, 403, 422, 503])('releases all PR update responses (%i)', async (status) => {
  const owner = responseOwner()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const sleepImpl = vi.fn(async () => {})
  for (let cycle = 0; cycle < 30; cycle += 1) {
    const result = updatePullRequest({
      ...pullOptions,
      fetchImpl: async (_url, options) =>
        options.method === 'PATCH' ? owner.response(status) : Response.json({ body: 'PR body' }),
      sleepImpl
    })
    await (status === 200 || status === 403
      ? expect(result).resolves.toBe(0)
      : expect(result).rejects.toThrow(`Failed to update PR #9: ${status} status ${status}`))
  }
  expect(owner.active.size).toBe(0)
  expect(owner.cancellations).toBe(status === 503 ? 90 : 30)
  expect(sleepImpl).toHaveBeenCalledTimes(status === 503 ? 60 : 0)
})

it('releases transient PR update bodies before the retry delay', async () => {
  const owner = responseOwner()
  const statuses = [503, 502, 200]
  const delays = []
  vi.spyOn(console, 'log').mockImplementation(() => {})
  await expect(
    updatePullRequest({
      ...pullOptions,
      fetchImpl: async (_url, options) =>
        options.method === 'PATCH'
          ? owner.response(statuses.shift())
          : Response.json({ body: 'PR body' }),
      sleepImpl: async (milliseconds) => {
        expect(owner.active.size).toBe(0)
        delays.push(milliseconds)
      }
    })
  ).resolves.toBe(0)
  expect(delays).toEqual([1000, 2000])
  expect(owner.cancellations).toBe(3)
  expect(owner.active.size).toBe(0)
})

it('preserves PR errors and update success when body cancellation rejects', async () => {
  const owner = responseOwner()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  await expect(
    listPullFiles({ ...pullOptions, fetchImpl: async () => owner.response(500, true) })
  ).rejects.toThrow('Failed to list PR #9 files: 500 status 500')
  await expect(
    updatePullRequest({ ...pullOptions, fetchImpl: async () => owner.response(404, true) })
  ).rejects.toThrow('Failed to read PR #9: 404 status 404')
  await expect(
    updatePullRequest({
      ...pullOptions,
      fetchImpl: async (_url, options) =>
        options.method === 'PATCH' ? owner.response(200, true) : Response.json({ body: 'PR body' })
    })
  ).resolves.toBe(0)
  expect(owner.cancellations).toBe(3)
  expect(owner.active.size).toBe(0)
})

it.each([403, 503])('releases failed downloads badge responses (%i)', async (status) => {
  const owner = responseOwner()
  vi.stubGlobal('fetch', async () => owner.response(status))
  for (let cycle = 0; cycle < 30; cycle += 1) {
    vi.resetModules()
    await expect(import('../../.github/scripts/render-readme-downloads-badge.mjs')).rejects.toThrow(
      `GitHub API request failed: ${status} status ${status}`
    )
  }
  expect(owner.cancellations).toBe(30)
  expect(owner.active.size).toBe(0)
})

it('preserves the badge request error when body cancellation rejects', async () => {
  const owner = responseOwner()
  vi.stubGlobal('fetch', async () => owner.response(503, true))
  vi.resetModules()
  await expect(import('../../.github/scripts/render-readme-downloads-badge.mjs')).rejects.toThrow(
    'GitHub API request failed: 503 status 503'
  )
  expect(owner.cancellations).toBe(1)
  expect(owner.active.size).toBe(0)
})

it('consumes successful badge pages and writes the accumulated count', async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), 'orca-downloads-badge-'))
  const responses = [
    Response.json([
      { draft: false, assets: [{ download_count: 1200 }, { download_count: 100 }] },
      { draft: true, assets: [{ download_count: 9000 }] }
    ]),
    Response.json([{ draft: false, assets: [{ download_count: 400 }] }]),
    Response.json([])
  ]
  let page = 0
  const fetchImpl = vi.fn(async () => responses[page++])
  vi.stubGlobal('fetch', fetchImpl)
  vi.stubEnv('DOWNLOADS_BADGE_PATH', join(outputRoot, 'test-downloads.svg'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.resetModules()
  try {
    await import('../../.github/scripts/render-readme-downloads-badge.mjs')
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(responses.every((response) => response.bodyUsed)).toBe(true)
    expect(await readFile(join(outputRoot, 'test-downloads.svg'), 'utf8')).toContain('2k')
  } finally {
    await rm(outputRoot, { recursive: true, force: true })
  }
})

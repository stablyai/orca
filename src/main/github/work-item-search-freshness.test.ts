import { expect, it, vi } from 'vitest'
import { api, capture } from './work-item-search-test-harness'
import { searchWorkItemCount, searchWorkItemPage } from './client/list/work-item-search-page'

it('does not renew a gh-cached response after bounded response-cache eviction', async () => {
  const ghCache = new Map<
    string,
    { expires: number; response: { stdout: string; stderr: string } }
  >()
  capture.mockImplementation(async (binary, args, options) => {
    const key = JSON.stringify([options.cwd, options.env?.GH_TOKEN, args])
    const cached = args.includes('--cache') ? ghCache.get(key) : undefined
    if (cached && cached.expires > Date.now()) {
      return cached.response
    }
    const response = await api.capture(binary, args, options)
    if (args.includes('--cache')) {
      ghCache.set(key, { expires: Date.now() + 120000, response })
    }
    return response
  })
  const search = 'repo:fixture/first is:issue'
  expect(await searchWorkItemCount(search, {})).toBe(120)
  for (let index = 0; index < 512; index++) {
    await searchWorkItemCount(`repo:fixture/evict-${index} is:issue`, {})
  }
  api.reportedCount = 121
  vi.setSystemTime(119000)
  await searchWorkItemCount(search, {})
  vi.setSystemTime(120001)
  expect(await searchWorkItemCount(search, {})).toBe(121)
})

it('starts a forced read independently of an uncached content read in flight', async () => {
  let release: (() => void) | undefined
  let started: (() => void) | undefined
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  capture.mockImplementation(async (binary, args, options) => {
    const result = await api.capture(binary, args, options)
    if (api.graphqlCalls === 1) {
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      started?.()
      await held
    }
    return result
  })
  const args = {
    search: 'repo:fixture/repo is:issue',
    nodeSelection: '__typename',
    limit: 24,
    page: 1,
    options: {},
    cacheResults: false
  }
  const ordinary = searchWorkItemPage(args)
  await firstStarted
  const forced = searchWorkItemPage({ ...args, noCache: true })
  try {
    await vi.waitFor(() => expect(api.graphqlCalls).toBe(2))
  } finally {
    release?.()
  }
  expect(await ordinary).toHaveLength(24)
  expect(await forced).toHaveLength(24)
})

import { expect, it, vi } from 'vitest'
import { api, capture } from './work-item-search-test-harness'
import { searchWorkItemCount } from './client/list/work-item-search-page'

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

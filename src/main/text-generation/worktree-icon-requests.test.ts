import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { InternalTextGenerationResult } from './source-control-text-generation-types'

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  generate: vi.fn(),
  cancel: vi.fn(),
  resolve: vi.fn()
}))
vi.mock('./commit-message-agent-environment', () => ({
  prepareLocalCommitMessageAgentEnv: mocks.prepare
}))
vi.mock('./agent-generation-request', () => ({ runGenerationRequest: mocks.generate }))
vi.mock('./source-control-generation-lanes', () => ({ cancelLocalGeneration: mocks.cancel }))
vi.mock('./source-control-agent-launch', () => ({ spawnSourceControlAgent: vi.fn() }))
vi.mock('./commit-message-text-generation', () => ({
  resolveTextGenerationParams: mocks.resolve
}))

let directory: string
beforeEach(() => {
  vi.resetModules()
  mocks.prepare.mockReset().mockResolvedValue({ ok: true })
  mocks.generate.mockReset()
  mocks.cancel.mockReset()
  mocks.resolve.mockReset().mockReturnValue({
    ok: true,
    params: { agentId: 'claude', model: 'haiku' }
  })
  directory = mkdtempSync(path.join(os.tmpdir(), 'orca-icon-'))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(directory, { recursive: true, force: true })
})

async function setup() {
  const { generateWorktreeIconRequest } = await import('./worktree-icon-requests')
  const host = {
    getSettings: () => ({}),
    getAgentEnvironment: () => undefined,
    cacheFile: path.join(directory, 'icons.json')
  }
  return (name: string, controller: AbortController) =>
    generateWorktreeIconRequest(host, name, controller.signal)
}
const success: InternalTextGenerationResult = {
  success: true,
  rawOutput: '<svg viewBox="0 0 18 15"><path d="M1 1h5"/></svg>'
}

it('cancels an abandoned queued icon while preserving the next live request', async () => {
  const request = await setup()
  const running = Promise.withResolvers<InternalTextGenerationResult>()
  const started = Promise.withResolvers<void>()
  mocks.generate
    .mockImplementationOnce(() => {
      started.resolve()
      return running.promise
    })
    .mockResolvedValue(success)
  const first = request('first', new AbortController())
  await started.promise
  const abandoned = new AbortController()
  const obsolete = request('obsolete', abandoned)
  const live = request('live', new AbortController())
  abandoned.abort()
  expect(await obsolete).toMatchObject({ success: false, canceled: true })
  running.resolve(success)
  expect(await first).toMatchObject({ success: true })
  expect(await live).toMatchObject({ success: true })
})

it('keeps shared generation alive for another consumer and allows reacquiring a canceled name', async () => {
  const request = await setup()
  const environment = Promise.withResolvers<{ ok: true }>()
  mocks.prepare.mockReturnValueOnce(environment.promise)
  mocks.generate.mockResolvedValue(success)
  const owner = new AbortController()
  const first = request('shared', owner)
  const second = request('shared', new AbortController())
  owner.abort()
  expect(await first).toMatchObject({ success: false, canceled: true })
  environment.resolve({ ok: true })
  expect(await second).toMatchObject({ success: true })

  const preparation = Promise.withResolvers<{ ok: true }>()
  mocks.prepare.mockReturnValueOnce(preparation.promise)
  const oldOwner = new AbortController()
  const old = request('renewed', oldOwner)
  oldOwner.abort()
  expect(await old).toMatchObject({ success: false, canceled: true })
  const renewed = request('renewed', new AbortController())
  preparation.resolve({ ok: true })
  expect(await renewed).toMatchObject({ success: true })
})

it('draws icons requested together in one agent run, matched by icon number', async () => {
  const request = await setup()
  mocks.generate.mockResolvedValue({
    success: true,
    rawOutput: [
      '<svg id="icon-2" viewBox="0 0 18 15"><path d="M2 2h2"/></svg>',
      '<svg id="icon-1" viewBox="0 0 18 15"><path d="M1 1h1"/></svg>'
    ].join('\n')
  })
  const [alpha, beta] = await Promise.all([
    request('alpha', new AbortController()),
    request('beta', new AbortController())
  ])
  expect(mocks.generate).toHaveBeenCalledTimes(1)
  expect(alpha).toMatchObject({ success: true, svg: expect.stringContaining('M1 1h1') })
  expect(beta).toMatchObject({ success: true, svg: expect.stringContaining('M2 2h2') })
})

it('clears queued requests and prevents a partially completed old recipe from restoring the disk cache', async () => {
  vi.useFakeTimers()
  const { clearWorktreeIconCache, generateWorktreeIconRequest } =
    await import('./worktree-icon-requests')
  const host = {
    getSettings: () => ({}),
    getAgentEnvironment: () => undefined,
    cacheFile: path.join(directory, 'icons.json')
  }
  mocks.resolve.mockImplementation((_settings, _host, operation) => ({
    ok: true,
    params: { agentId: operation === 'workspaceIcon' ? 'claude' : 'codex', model: 'haiku' }
  }))
  const fallback = Promise.withResolvers<InternalTextGenerationResult>()
  const fresh = Promise.withResolvers<InternalTextGenerationResult>()
  mocks.generate
    .mockResolvedValueOnce({
      success: true,
      rawOutput: '<svg id="icon-1"><path d="M1 1h1"/></svg>'
    })
    .mockReturnValueOnce(fallback.promise)
    .mockReturnValueOnce(fresh.promise)
  const request = (name: string) =>
    generateWorktreeIconRequest(host, name, new AbortController().signal)
  const first = request('alpha')
  const second = request('beta')
  await vi.advanceTimersByTimeAsync(100)
  const queued = request('queued')
  clearWorktreeIconCache(host)
  fallback.resolve(success)
  await vi.advanceTimersByTimeAsync(0)
  expect(await first).toMatchObject({ success: false, canceled: true })
  expect(await second).toMatchObject({ success: false, canceled: true })
  expect(await queued).toMatchObject({ success: false, canceled: true })
  expect(existsSync(host.cacheFile)).toBe(false)
  const regenerated = request('alpha')
  await vi.advanceTimersByTimeAsync(100)
  fresh.resolve({ success: true, rawOutput: '<svg><path d="M9 9h9"/></svg>' })
  expect(await regenerated).toEqual({
    success: true,
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M9 9h9"/></svg>'
  })
  expect(JSON.parse(readFileSync(host.cacheFile, 'utf8'))).toEqual({
    alpha: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M9 9h9"/></svg>'
  })
})

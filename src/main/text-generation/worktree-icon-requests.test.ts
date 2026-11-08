import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { InternalTextGenerationResult } from './source-control-text-generation-types'

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), generate: vi.fn(), cancel: vi.fn() }))
vi.mock('./commit-message-agent-environment', () => ({
  prepareLocalCommitMessageAgentEnv: mocks.prepare
}))
vi.mock('./agent-generation-request', () => ({ runGenerationRequest: mocks.generate }))
vi.mock('./source-control-generation-lanes', () => ({ cancelLocalGeneration: mocks.cancel }))
vi.mock('./source-control-agent-launch', () => ({ spawnSourceControlAgent: vi.fn() }))
vi.mock('./commit-message-text-generation', () => ({
  resolveTextGenerationParams: () => ({ ok: false })
}))

let directory: string
beforeEach(() => {
  vi.resetModules()
  mocks.prepare.mockReset().mockResolvedValue({ ok: true })
  mocks.generate.mockReset()
  mocks.cancel.mockReset()
  directory = mkdtempSync(path.join(os.tmpdir(), 'orca-icon-'))
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

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

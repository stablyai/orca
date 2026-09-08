import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isolatedScanRoots } from '../main/ai-vault/session-scanner-test-fixtures'

const discovery = vi.hoisted(() => vi.fn())
vi.mock('../main/ai-vault/session-scanner-source-discovery', () => ({
  discoverAiVaultSessionSources: discovery
}))
import { RelaySessionSearchOwner } from './session-search-owner'
import { SessionSearchStore } from '../main/ai-vault-search/session-search-store'
import * as candidateParser from '../main/ai-vault-search/session-search-parse-candidates'

let owner: RelaySessionSearchOwner | undefined
let directory: string | undefined
afterEach(async () => {
  await owner?.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
  discovery.mockReset()
  if (directory) {
    await rm(directory, { recursive: true, force: true })
  }
})

it('allows discovery longer than an ownership window to finish', async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-search-progress-'))
  vi.useFakeTimers()
  let complete: (() => void) | undefined
  let aborted = 0
  discovery.mockImplementation(
    ({ options }) =>
      new Promise((resolve, reject) => {
        complete = () => resolve([])
        options.signal.addEventListener(
          'abort',
          () => {
            aborted++
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          },
          { once: true }
        )
      })
  )
  owner = new RelaySessionSearchOwner(directory, {
    directory: join(directory, 'search'),
    roots: isolatedScanRoots(directory)
  })
  const state = vi.spyOn(SessionSearchStore.prototype, 'setBackfillState')
  await owner.request('configure', { enabled: true })
  await vi.advanceTimersByTimeAsync(6_000)
  expect(discovery).toHaveBeenCalledOnce()
  expect(aborted).toBe(0)
  complete!()
  await vi.advanceTimersByTimeAsync(0)
  expect(state).toHaveBeenCalledWith('complete')
  const replacement = new RelaySessionSearchOwner(directory, {
    directory: join(directory, 'search'),
    roots: isolatedScanRoots(directory)
  })
  try {
    await expect(replacement.request('configure', { enabled: false })).resolves.toMatchObject({
      enabled: false,
      applied: true
    })
  } finally {
    await replacement.close()
  }
  await expect(owner.request('status', {})).resolves.toMatchObject({ enabled: false })
  state.mockRestore()
})

it('finishes a slow parse before handing ownership to another relay', async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-search-progress-'))
  vi.useFakeTimers()
  discovery.mockResolvedValue([])
  let complete: (() => void) | undefined
  let parseSignal: AbortSignal | undefined
  vi.spyOn(candidateParser, 'parseSearchCandidates').mockImplementation(
    (_store, _candidates, options) =>
      new Promise<void>((resolve) => {
        complete = resolve
        parseSignal = options?.signal
        options?.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
  )
  const state = vi.spyOn(SessionSearchStore.prototype, 'setBackfillState')
  owner = new RelaySessionSearchOwner(directory, {
    directory: join(directory, 'search'),
    roots: isolatedScanRoots(directory)
  })
  await owner.request('configure', { enabled: true })
  await vi.advanceTimersByTimeAsync(6_000)
  expect(complete).toBeDefined()
  expect(parseSignal?.aborted).toBe(false)
  complete!()
  await vi.advanceTimersByTimeAsync(0)
  expect(state).toHaveBeenCalledWith('complete')
})

it('lets pause interrupt slow discovery even after the ownership deadline', async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-search-progress-'))
  vi.useFakeTimers()
  let aborted = false
  discovery.mockImplementation(
    ({ options }) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => {
            aborted = true
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          },
          { once: true }
        )
      })
  )
  owner = new RelaySessionSearchOwner(directory, {
    directory: join(directory, 'search'),
    roots: isolatedScanRoots(directory)
  })
  await owner.request('configure', { enabled: true })
  await vi.advanceTimersByTimeAsync(6_000)
  expect(aborted).toBe(false)
  await expect(owner.request('configure', { paused: true })).resolves.toMatchObject({
    enabled: true,
    paused: true,
    applied: true
  })
  expect(aborted).toBe(true)
})

it('does not let an expired pass release ownership of a queued resumed pass', async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-search-progress-'))
  vi.useFakeTimers()
  const signals: AbortSignal[] = []
  discovery.mockImplementation(
    ({ options }) =>
      new Promise((_resolve, reject) => {
        signals.push(options.signal)
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
  )
  owner = new RelaySessionSearchOwner(directory, {
    directory: join(directory, 'search'),
    roots: isolatedScanRoots(directory)
  })
  await owner.request('configure', { enabled: true })
  await vi.advanceTimersByTimeAsync(6_000)
  const paused = owner.request('configure', { paused: true })
  const resumed = owner.request('configure', { paused: false })
  await Promise.all([paused, resumed])
  await vi.advanceTimersByTimeAsync(0)
  expect(signals).toHaveLength(2)
  expect(signals[0].aborted).toBe(true)
  expect(signals[1].aborted).toBe(false)
})

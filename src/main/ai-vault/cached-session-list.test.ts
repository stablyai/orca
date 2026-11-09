import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AiVaultScanOptions } from './session-scanner-types'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, writeJsonlFile } from './session-scanner-test-fixtures'

const { scan } = vi.hoisted(() => ({ scan: vi.fn() }))
vi.mock('./scan-service/session-scanner-background', () => ({
  scanAiVaultSessionsInBackground: scan,
  clearAiVaultBackgroundRestartCircuit: () => {},
  resetAiVaultScannerBackgroundForTests: () => {}
}))
vi.mock('../wsl/discovery/distro-catalog', () => ({
  hasCachedWslDistros: () => true,
  getCachedWslDistros: () => []
}))

import { listAiVaultSessions, resetAiVaultSessionListCacheForTests } from './cached-session-list'

let root: string | undefined

afterEach(async () => {
  resetAiVaultSessionListCacheForTests()
  scan.mockReset()
  vi.useRealTimers()
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

it.each([250, 500])(
  'uses the newer full-scope snapshot after a Project scan at depth %s',
  async (projectDepth) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-09T12:00:00.000Z'))
    const tempRoot = await mkdtemp(join(tmpdir(), 'orca-session-list-cache-'))
    root = tempRoot
    const roots = isolatedScanRoots(tempRoot)
    scan.mockImplementation((options: AiVaultScanOptions, signal: AbortSignal) =>
      scanAiVaultSessions({
        ...options,
        ...roots,
        additionalCodexSessionsDirs: [],
        wslHomeDirs: [],
        claudeProfileProjectsDirs: [],
        opencodeAccountDataDirs: [],
        antigravityChatBrainDir: join(tempRoot, 'chat-brain'),
        signal
      })
    )
    const writeSession = (id: string, title: string) =>
      writeJsonlFile(join(roots.claudeProjectsDir, '-repo', `${id}.jsonl`), [
        {
          type: 'user',
          sessionId: id,
          cwd: '/repo',
          timestamp: '2026-11-09T11:00:00.000Z',
          message: { role: 'user', content: title }
        }
      ])
    const scopePaths = ['/repo']
    await writeSession('initial', 'Initial conversation')
    await listAiVaultSessions({ scopePaths, scopeOnly: true, limit: projectDepth })
    await writeSession('newer', 'Newer conversation')
    await listAiVaultSessions({ scopePaths, limit: 500 })
    await writeSession('after-snapshot', 'Later conversation')

    const result = await listAiVaultSessions({ scopePaths, scopeOnly: true, limit: 500 })

    expect(result.sessions.map((session) => session.title).sort()).toEqual([
      'Initial conversation',
      'Newer conversation'
    ])
  }
)

it('caches a later All refresh after overlapping Project refresh completes first', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'orca-review-cache-race-'))
  root = tempRoot
  const roots = isolatedScanRoots(tempRoot)
  const projectStarted = Promise.withResolvers<void>()
  const allStarted = Promise.withResolvers<void>()
  const projectGate = Promise.withResolvers<void>()
  const allGate = Promise.withResolvers<void>()
  scan.mockImplementation(async (options: AiVaultScanOptions, signal: AbortSignal) => {
    const result = await scanAiVaultSessions({
      ...options,
      ...roots,
      additionalCodexSessionsDirs: [],
      wslHomeDirs: [],
      claudeProfileProjectsDirs: [],
      opencodeAccountDataDirs: [],
      antigravityChatBrainDir: join(tempRoot, 'chat-brain'),
      signal
    })
    if (options.scopeOnly) {
      projectStarted.resolve()
      await projectGate.promise
    } else {
      allStarted.resolve()
      await allGate.promise
    }
    return result
  })
  const writeSession = (id: string) =>
    writeJsonlFile(join(roots.claudeProjectsDir, '-repo', `${id}.jsonl`), [
      {
        type: 'user',
        sessionId: id,
        cwd: '/repo',
        timestamp: '2026-11-09T11:00:00.000Z',
        message: { role: 'user', content: id }
      }
    ])
  await writeSession('initial')
  const project = listAiVaultSessions({
    scopePaths: ['/repo'],
    scopeOnly: true,
    limit: 500,
    force: true
  })
  await projectStarted.promise
  await writeSession('newer')
  const all = listAiVaultSessions({ scopePaths: ['/repo'], limit: 500, force: true })
  await allStarted.promise
  projectGate.resolve()
  await project
  allGate.resolve()
  expect((await all).sessions.map((s) => s.sessionId).sort()).toEqual(['initial', 'newer'])
  const cached = await listAiVaultSessions({ scopePaths: ['/repo'], scopeOnly: true, limit: 500 })
  expect(cached.sessions.map((s) => s.sessionId).sort()).toEqual(['initial', 'newer'])
})

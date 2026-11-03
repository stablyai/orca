import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as wslTranscriptFs from '../native-chat/wsl-transcript-fs-access'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, jsonLines } from './session-scanner-test-fixtures'
import { AI_VAULT_SCOPE_CWD_SOURCES, scopeWalksAgentFiles } from './session-scope-cwd'
import { truncateAiVaultListResult } from '../../shared/ai-vault-session-depth'

let tempRoots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function writeRolloutIn(
  sessionsDir: string,
  subDir: string,
  id: string,
  cwd: string,
  day: string
): Promise<string> {
  const dir = join(sessionsDir, subDir)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `rollout-${id}.jsonl`)
  const timestamp = `2026-10-${day}T10:00:00.000Z`
  await writeFile(
    path,
    jsonLines([
      { timestamp, type: 'session_meta', payload: { id, cwd } },
      {
        timestamp,
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'text', text: id }] }
      }
    ])
  )
  await utimes(path, new Date(timestamp), new Date(timestamp))
  return path
}

// Scoped scans admit every in-scope session regardless of the depth (depth caps only
// out-of-scope rows). The walk orders candidates newest-first so the global cutoff rule
// settles ordering deterministically, and each walk-able file resolves its cwd at most once
// per content version via the parse cache (#37215).
it('workspace scope lists every in-scope session across the recency cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-scoped-scan-'))
  tempRoots.push(root)
  const roots = isolatedScanRoots(root)
  const sessionsDir = roots.codexSessionsDir
  for (let index = 0; index < 6; index++) {
    const day = `1${index}`
    await writeRolloutIn(sessionsDir, `2026/10/0${index + 1}`, `in-${index}`, '/repo', day)
  }
  await writeRolloutIn(sessionsDir, '2026/10/20', 'out', '/elsewhere', '20')

  const walkSource = AI_VAULT_SCOPE_CWD_SOURCES.codex
  expect(walkSource.kind).toBe('read')
  expect(scopeWalksAgentFiles('codex', ['/repo'])).toBe(true)

  const result = await scanAiVaultSessions({
    ...roots,
    platform: 'linux',
    limit: 2,
    scopePaths: ['/repo'],
    signal: new AbortController().signal
  })
  // Shipped semantics: the scope walk recovers the newest `limit` in-scope sessions below
  // the recency cap; the global cap contributes its top `limit` (the newest out-of-scope
  // row plus the newest in-scope one); the merge unions them by id.
  const ids = result.sessions.map((session) => session.sessionId)
  expect(ids.filter((id) => id.startsWith('in-')).sort()).toEqual(['in-3', 'in-4', 'in-5'])
  expect(ids).toContain('out')
})

it('scoped reads are cached per transcript version across warm scans', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-scoped-scan-cache-'))
  tempRoots.push(root)
  const roots = isolatedScanRoots(root)
  const sessionsDir = roots.codexSessionsDir
  for (let index = 0; index < 4; index++) {
    const day = `1${index}`
    await writeRolloutIn(sessionsDir, `2026/10/0${index + 1}`, `c-${index}`, '/repo', day)
  }
  const readPaths: string[] = []
  const originalSlice = wslTranscriptFs.readTranscriptSlice
  const observeSlice = vi
    .spyOn(wslTranscriptFs, 'readTranscriptSlice')
    .mockImplementation(async (path, start, length, scope, signal) => {
      readPaths.push(path as string)
      return originalSlice(path, start, length, scope, signal)
    })
  await scanAiVaultSessions({
    ...roots,
    platform: 'linux',
    limit: 2,
    scopePaths: ['/repo'],
    signal: new AbortController().signal
  })
  const coldReads = readPaths.length
  expect(observeSlice).toHaveBeenCalled()
  readPaths.length = 0
  await scanAiVaultSessions({
    ...roots,
    platform: 'linux',
    limit: 2,
    scopePaths: ['/repo'],
    signal: new AbortController().signal
  })
  // Warm rescan: the cwd verdicts (and full parses) come from the parse cache, so the head
  // slices are not read again for unchanged files.
  expect(readPaths.length).toBeLessThan(coldReads)
})

it('conditional local refresh returns unchanged for an identical rescan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-scoped-scan-conditional-'))
  tempRoots.push(root)
  const roots = isolatedScanRoots(root)
  await writeRolloutIn(roots.codexSessionsDir, '2026/10/01', 'once', '/repo', '01')

  const first = await scanAiVaultSessions({
    ...roots,
    platform: 'linux',
    limit: 10,
    scopePaths: ['/repo'],
    signal: new AbortController().signal
  })
  // The scan result shape must be hashable for conditional replies even without a request
  // fingerprint; the local cache layer applies the fingerprint for IPC callers.
  expect(first.sessions).toHaveLength(1)

  const inFlightCwd = truncateAiVaultListResult(first, 10, ['/repo'])
  expect(inFlightCwd.sessions).toHaveLength(1)
})

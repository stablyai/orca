import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import type * as Fs from 'node:fs'
import {
  createCodexRolloutVisibilityPredicate,
  recordCodexSessionDeletion
} from '../codex/history/deletion/codex-session-deletion-record'
import { discoverAiVaultSessionSources } from './session-scanner-source-discovery'
import type { AiVaultScanIssue } from '../../shared/ai-vault/contracts/ai-vault-types'

const mocks = vi.hoisted(() => ({
  readdir: vi.fn(),
  lstatSync: vi.fn(),
  createPredicate: vi.fn(),
  discover: vi.fn()
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof FsPromises>()
  mocks.readdir.mockImplementation(original.readdir)
  return { ...original, readdir: mocks.readdir }
})
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof Fs>()
  mocks.lstatSync.mockImplementation(original.lstatSync)
  return { ...original, lstatSync: mocks.lstatSync }
})
vi.mock('./session-scanner-agent-sources', () => ({
  AI_VAULT_AGENT_SOURCES: {
    codex: {
      rootDirs: () => ['/system/sessions', '/managed/sessions'],
      extensions: ['.jsonl'],
      createFilePredicate: mocks.createPredicate
    }
  }
}))
vi.mock('./session-scanner-discovery', () => ({ discoverFiles: mocks.discover }))
vi.mock('./scanners/opencode/session-scanner-opencode-sources', () => ({
  opencodeDiscoveries: () => []
}))
vi.mock('./scanners/zcode/session-scanner-zcode-sources', () => ({ zcodeDiscoveries: () => [] }))
vi.mock('./scanners/antigravity/session-scanner-antigravity-sources', () => ({
  antigravityDiscoveries: () => []
}))

const SESSION = '019f0000-1111-7222-8333-000000000001'
const file = `/system/sessions/rollout-2026-10-11T12-00-00-${SESSION}.jsonl`
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-codex-scan-predicate-'))
  vi.stubEnv('ORCA_USER_DATA_PATH', root)
  vi.clearAllMocks()
  mocks.createPredicate.mockImplementation(createCodexRolloutVisibilityPredicate)
  mocks.discover.mockImplementation(async ({ rootDir, filePredicate }) => {
    for (let index = 0; index < 1000; index++) {
      filePredicate(file)
    }
    return { agent: 'codex', rootDir, files: [] }
  })
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

describe('scan-scoped Codex deletion visibility', () => {
  it('loads deletion IDs once across roots and does no per-candidate filesystem checks', async () => {
    await recordCodexSessionDeletion(SESSION, true)
    mocks.lstatSync.mockClear()
    await discoverAiVaultSessionSources({ options: {}, limitPerAgent: 100, issues: [] })
    expect(mocks.createPredicate).toHaveBeenCalledTimes(1)
    expect(mocks.readdir).toHaveBeenCalledTimes(1)
    expect(mocks.lstatSync).not.toHaveBeenCalled()
    const firstPredicate = mocks.discover.mock.calls[0]?.[0].filePredicate
    expect(firstPredicate).toBe(mocks.discover.mock.calls[1]?.[0].filePredicate)
    expect(firstPredicate(file)).toBe(false)
  })

  it('refreshes the snapshot on the next scan and keeps WSL UUIDs independent', async () => {
    await discoverAiVaultSessionSources({ options: {}, limitPerAgent: 100, issues: [] })
    const firstPredicate = mocks.discover.mock.calls[0]?.[0].filePredicate
    expect(firstPredicate(file)).toBe(true)
    await recordCodexSessionDeletion(SESSION, true)
    await discoverAiVaultSessionSources({ options: {}, limitPerAgent: 100, issues: [] })
    const nextPredicate = mocks.discover.mock.calls[2]?.[0].filePredicate
    expect(nextPredicate(file)).toBe(false)
    expect(
      nextPredicate(
        String.raw`\\wsl.localhost\Ubuntu\home\user\.codex\sessions\rollout-2026-10-11T12-00-00-${SESSION}.jsonl`
      )
    ).toBe(true)
    expect(mocks.readdir).toHaveBeenCalledTimes(2)
  })

  it('preserves discovery errors instead of turning them into predicate failures', async () => {
    mocks.discover.mockRejectedValueOnce(new Error('Discovery failed'))
    const issues: AiVaultScanIssue[] = []
    await expect(
      discoverAiVaultSessionSources({ options: {}, limitPerAgent: 100, issues })
    ).rejects.toThrow('Discovery failed')
    expect(issues).toEqual([])
  })

  it('reports an unreadable deletion snapshot and refuses to scan Codex candidates', async () => {
    mocks.createPredicate.mockRejectedValueOnce(new Error('Cannot read deletion records'))
    const issues: AiVaultScanIssue[] = []
    const discoveries = await discoverAiVaultSessionSources({
      options: {},
      limitPerAgent: 100,
      issues
    })
    expect(mocks.discover).not.toHaveBeenCalled()
    expect(discoveries.every((discovery) => discovery.files.length === 0)).toBe(true)
    expect(issues).toContainEqual(
      expect.objectContaining({ agent: 'codex', message: 'Cannot read deletion records' })
    )
  })
})

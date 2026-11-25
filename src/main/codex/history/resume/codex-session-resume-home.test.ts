import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  findTrustedCodexSessionResume,
  resolveCodexSessionResumeProvenance,
  resolveTrustedCodexSessionResumeHome
} from './codex-session-resume-home'

const tempRoots: string[] = []

const withoutHomeRanking = {
  getSelectedAccountCodexHome: (): string | null => null,
  systemCodexHomePath: null,
  sharedRuntimeCodexHomePath: null
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('resolveTrustedCodexSessionResumeHome', () => {
  it('rejects unsafe or unrelated Windows namespace paths before probing files', () => {
    const fileIsRegular = vi.fn((): boolean => true)
    const trustedCodexHomes = ['C:\\Users\\Example\\.codex']
    const rejectedPaths = [
      '\\\\?\\D:\\Users\\Example\\.codex\\sessions\\2026\\07\\20\\rollout-a.jsonl',
      '\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy1\\sessions\\2026\\07\\20\\rollout-a.jsonl',
      '\\\\?\\Volume{00000000-0000-0000-0000-000000000000}\\sessions\\2026\\07\\20\\rollout-a.jsonl',
      '\\\\.\\C:\\Users\\Example\\.codex\\sessions\\2026\\07\\20\\rollout-a.jsonl',
      '\\\\?\\C:\\Users\\Example\\.codex\\sessions\\2026\\07\\20\\rollout-a:stream.jsonl',
      '\\\\?\\C:\\Users\\Example\\.codex\\sessions\\2026\\07\\20\\..\\rollout-a.jsonl'
    ]

    for (const transcriptPath of rejectedPaths) {
      expect(
        resolveTrustedCodexSessionResumeHome({
          transcriptPath,
          trustedCodexHomes,
          fileIsRegular
        })
      ).toBeNull()
    }
    expect(fileIsRegular).not.toHaveBeenCalled()
  })

  // Comparison normalization must not change paths used for file access.

  it('rejects paths outside trusted homes or outside the rollout layout', () => {
    const fileIsRegular = vi.fn((): boolean => true)
    expect(
      resolveTrustedCodexSessionResumeHome({
        transcriptPath: '/tmp/sessions/2026/07/20/rollout-a.jsonl',
        trustedCodexHomes: ['/Users/example/.codex'],
        fileIsRegular
      })
    ).toBeNull()
    expect(
      resolveTrustedCodexSessionResumeHome({
        transcriptPath: '/Users/example/.codex/sessions/index.jsonl',
        trustedCodexHomes: ['/Users/example/.codex'],
        fileIsRegular
      })
    ).toBeNull()
    expect(
      resolveTrustedCodexSessionResumeHome({
        transcriptPath:
          '/Users/example/.codex/sessions/2026/07/20/rollout-a/../../../../outside.jsonl',
        trustedCodexHomes: ['/Users/example/.codex'],
        fileIsRegular
      })
    ).toBeNull()
    expect(fileIsRegular).not.toHaveBeenCalled()
  })

  it('requires the transcript provenance to name a regular rollout file', () => {
    const homePath = mkdtempSync(join(tmpdir(), 'orca-codex-resume-home-'))
    tempRoots.push(homePath)
    const rolloutDirectory = join(homePath, 'sessions', '2026', '07', '20', 'rollout-a.jsonl')
    mkdirSync(rolloutDirectory, { recursive: true })

    expect(
      resolveTrustedCodexSessionResumeHome({
        transcriptPath: rolloutDirectory,
        trustedCodexHomes: [homePath]
      })
    ).toBeNull()

    const rolloutFile = join(homePath, 'sessions', '2026', '07', '20', 'rollout-b.jsonl')
    writeFileSync(rolloutFile, '{}\n')
    expect(
      resolveTrustedCodexSessionResumeHome({
        transcriptPath: rolloutFile,
        trustedCodexHomes: [homePath]
      })
    ).toBe(homePath)
  })

  it('follows Codex when a persisted plain rollout was compressed in place', async () => {
    const homePath = mkdtempSync(join(tmpdir(), 'orca-codex-resume-home-'))
    tempRoots.push(homePath)
    const plainPath = join(
      homePath,
      'sessions',
      '2026',
      '07',
      '20',
      'rollout-2026-07-20T12-00-00-session.jsonl'
    )
    const compressedPath = `${plainPath}.zst`
    mkdirSync(join(plainPath, '..'), { recursive: true })
    writeFileSync(compressedPath, 'compressed-rollout')

    await expect(
      findTrustedCodexSessionResume({
        sessionId: 'session-a',
        transcriptPath: plainPath,
        trustedCodexHomes: [homePath],
        ...withoutHomeRanking
      })
    ).resolves.toEqual({ homePath, transcriptPath: compressedPath })

    writeFileSync(plainPath, 'active-rollout')
    await expect(
      findTrustedCodexSessionResume({
        sessionId: 'session-a',
        transcriptPath: compressedPath,
        trustedCodexHomes: [homePath],
        ...withoutHomeRanking
      })
    ).resolves.toEqual({ homePath, transcriptPath: plainPath })
  })

  it('finds compressed rollouts for legacy records without transcript provenance', async () => {
    const homePath = mkdtempSync(join(tmpdir(), 'orca-codex-resume-home-'))
    tempRoots.push(homePath)
    const sessionId = '019f81b9-19a9-7651-a8d1-352d9420bd11'
    const compressedPath = join(
      homePath,
      'sessions',
      '2026',
      '07',
      '20',
      `rollout-2026-07-20T12-00-00-${sessionId}.jsonl.zst`
    )
    mkdirSync(join(compressedPath, '..'), { recursive: true })
    writeFileSync(compressedPath, 'compressed-rollout')

    await expect(
      findTrustedCodexSessionResume({
        sessionId,
        transcriptPath: undefined,
        trustedCodexHomes: [homePath],
        ...withoutHomeRanking
      })
    ).resolves.toEqual({ homePath, transcriptPath: compressedPath })
  })

  it('does not replace rejected transcript provenance with a same-id rollout from another home', async () => {
    const sessionId = '019f81b9-19a9-7651-a8d1-352d9420bd11'
    const listSessionFiles = vi.fn((): AsyncIterable<string> => {
      throw new Error('must not scan')
    })

    await expect(
      findTrustedCodexSessionResume({
        sessionId,
        transcriptPath: `/managed/origin/home/sessions/2026/07/20/rollout-${sessionId}.jsonl`,
        trustedCodexHomes: ['/managed/origin/home', '/managed/other/home'],
        ...withoutHomeRanking,
        fileIsRegular: () => false,
        listSessionFiles
      })
    ).resolves.toBeNull()
    expect(listSessionFiles).not.toHaveBeenCalled()
  })
})

describe('resolveCodexSessionResumeProvenance', () => {
  function writeRollout(sessionId: string): { homePath: string; rolloutPath: string } {
    const homePath = mkdtempSync(join(tmpdir(), 'orca-codex-resume-provenance-'))
    tempRoots.push(homePath)
    const rolloutPath = join(
      homePath,
      'sessions',
      '2026',
      '07',
      '20',
      `rollout-2026-07-20T12-00-00-${sessionId}.jsonl`
    )
    mkdirSync(join(rolloutPath, '..'), { recursive: true })
    writeFileSync(rolloutPath, 'rollout')
    return { homePath, rolloutPath }
  }

  it('starts fresh for a rollout file that really exists under a home Orca no longer trusts', async () => {
    const sessionId = '019f81b9-19a9-7651-a8d1-352d9420bd11'
    const removed = writeRollout(sessionId)
    const trusted = mkdtempSync(join(tmpdir(), 'orca-codex-resume-provenance-'))
    tempRoots.push(trusted)

    await expect(
      resolveCodexSessionResumeProvenance({
        sessionId,
        transcriptPath: removed.rolloutPath,
        trustedCodexHomes: [trusted],
        ...withoutHomeRanking
      })
    ).resolves.toEqual({ outcome: 'fresh', claimedCodexProvenance: true })
  })
})

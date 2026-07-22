import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  findTrustedCodexSessionResume,
  resolveTrustedCodexSessionResumeHome
} from './codex-session-resume-home'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('resolveTrustedCodexSessionResumeHome', () => {
  it('returns the trusted home containing a persisted rollout', () => {
    expect(
      resolveTrustedCodexSessionResumeHome({
        transcriptPath: '/Users/example/.codex/sessions/2026/07/20/rollout-session.jsonl',
        trustedCodexHomes: ['/managed/account/home', '/Users/example/.codex'],
        fileIsRegular: () => true
      })
    ).toBe('/Users/example/.codex')
  })

  it('accepts Windows paths case-insensitively', () => {
    expect(
      resolveTrustedCodexSessionResumeHome({
        transcriptPath: 'C:\\Users\\Example\\.codex\\sessions\\2026\\07\\20\\rollout-a.jsonl',
        trustedCodexHomes: ['c:\\users\\example\\.codex'],
        fileIsRegular: () => true
      })
    ).toBe('c:\\users\\example\\.codex')
  })

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

  it('rejects a trusted-looking path when the rollout no longer exists', () => {
    expect(
      resolveTrustedCodexSessionResumeHome({
        transcriptPath: '/Users/example/.codex/sessions/2026/07/20/rollout-a.jsonl',
        trustedCodexHomes: ['/Users/example/.codex'],
        fileIsRegular: () => false
      })
    ).toBeNull()
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
        trustedCodexHomes: [homePath]
      })
    ).resolves.toEqual({ homePath, transcriptPath: compressedPath })

    writeFileSync(plainPath, 'active-rollout')
    await expect(
      findTrustedCodexSessionResume({
        sessionId: 'session-a',
        transcriptPath: compressedPath,
        trustedCodexHomes: [homePath]
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
        trustedCodexHomes: [homePath]
      })
    ).resolves.toEqual({ homePath, transcriptPath: compressedPath })
  })

  it('finds older saved sessions by id when transcript provenance is absent', async () => {
    const sessionId = '019f81b9-19a9-7651-a8d1-352d9420bd11'
    const rolloutPath = `/managed/account/home/sessions/2026/07/20/rollout-2026-07-20T15-50-19-${sessionId}.jsonl`
    const listSessionFiles = async function* (sessionsRoot: string): AsyncIterable<string> {
      if (sessionsRoot === '/managed/account/home/sessions') {
        yield `/managed/account/home/sessions/misplaced-${sessionId}.jsonl`
        yield rolloutPath
      }
    }

    await expect(
      findTrustedCodexSessionResume({
        sessionId,
        transcriptPath: undefined,
        trustedCodexHomes: ['/Users/example/.codex', '/managed/account/home'],
        listSessionFiles
      })
    ).resolves.toEqual({ homePath: '/managed/account/home', transcriptPath: rolloutPath })
  })

  it('does not scan session trees when exact transcript provenance is valid', async () => {
    const transcriptPath =
      '/managed/account/home/sessions/2026/07/20/rollout-2026-07-20-session.jsonl'
    const listSessionFiles = vi.fn((): AsyncIterable<string> => {
      throw new Error('must not scan')
    })

    await expect(
      findTrustedCodexSessionResume({
        sessionId: 'session-a',
        transcriptPath,
        trustedCodexHomes: ['/managed/account/home'],
        fileIsRegular: () => true,
        listSessionFiles
      })
    ).resolves.toEqual({ homePath: '/managed/account/home', transcriptPath })
    expect(listSessionFiles).not.toHaveBeenCalled()
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
        fileIsRegular: () => false,
        listSessionFiles
      })
    ).resolves.toBeNull()
    expect(listSessionFiles).not.toHaveBeenCalled()
  })

  it('does not scan homes for an untrusted legacy session id shape', async () => {
    const listSessionFiles = (): AsyncIterable<string> => {
      throw new Error('must not scan')
    }
    await expect(
      findTrustedCodexSessionResume({
        sessionId: '../session',
        transcriptPath: undefined,
        trustedCodexHomes: ['/Users/example/.codex'],
        listSessionFiles
      })
    ).resolves.toBeNull()
  })
})

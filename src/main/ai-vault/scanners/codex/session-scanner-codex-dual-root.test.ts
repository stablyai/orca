import type * as TranscriptFs from '../../../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import { appendFile, copyFile, link, mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import { resetSessionParseCacheForTests } from '../../parse-cache/session-parse-cache-store'
import { sessionCandidatesFromDiscoveries } from '../../discovery/session-scanner-candidates'
import { scanAiVaultSessions } from '../../session-scanner'
import { isolatedScanRoots, jsonLines } from '../../scanner-fixtures/session-scanner-test-fixtures'

const reads = vi.hoisted(
  (): {
    failed: string
    failedSlice: string
    cancel: AbortController | null
    paths: string[]
  } => ({
    failed: '',
    failedSlice: '',
    cancel: null,
    paths: []
  })
)
vi.mock(
  '../../../native-chat/transcript-filesystem/wsl-transcript-fs-access',
  async (importOriginal) => {
    const actual = await importOriginal<typeof TranscriptFs>()
    return {
      ...actual,
      readTranscriptSlice: async (...args: Parameters<typeof actual.readTranscriptSlice>) => {
        if (args[0] === reads.failedSlice) {
          throw Object.assign(new Error('unreadable'), { code: 'EACCES' })
        }
        return actual.readTranscriptSlice(...args)
      },
      openTranscriptReadStream: (...args: Parameters<typeof actual.openTranscriptReadStream>) => {
        reads.paths.push(args[0])
        if (args[0] === reads.failed) {
          reads.cancel?.abort()
          return new Readable({
            read() {
              this.destroy(Object.assign(new Error('unreadable'), { code: 'EACCES' }))
            }
          })
        }
        return actual.openTranscriptReadStream(...args)
      }
    }
  }
)

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
  reads.failed = ''
  reads.failedSlice = ''
  reads.cancel = null
  reads.paths = []
  resetSessionParseCacheForTests()
})

describe('scanAiVaultSessions codex dual-root dedup', () => {
  it('lists a backfilled both-roots session once, attributed to the real home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-dedup-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const realHome = join(root, 'real-codex-home')
    const realSessionsDir = join(realHome, 'sessions')
    const managedHome = join(root, 'codex-runtime-home', 'home')
    const managedSessionsDir = join(managedHome, 'sessions')
    const rolloutName = 'rollout-2026-07-01T10-00-00-019f0000-1111-7222-8333-444444444444.jsonl'
    await mkdir(join(managedSessionsDir, '2026', '07', '01'), { recursive: true })
    await mkdir(join(realSessionsDir, '2026', '07', '01'), { recursive: true })

    await writeFile(
      join(managedSessionsDir, '2026', '07', '01', rolloutName),
      jsonLines([
        {
          timestamp: '2026-07-01T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: '019f0000-1111-7222-8333-444444444444', cwd: '/repo/app' }
        },
        {
          timestamp: '2026-07-01T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Backfilled both-roots session' }]
          }
        }
      ])
    )
    await link(
      join(managedSessionsDir, '2026', '07', '01', rolloutName),
      join(realSessionsDir, '2026', '07', '01', rolloutName)
    )
    // A rollout absent from the real home must retain its managed home for resume.
    await mkdir(join(managedSessionsDir, '2026', '07', '02'), { recursive: true })
    await writeFile(
      join(
        managedSessionsDir,
        '2026',
        '07',
        '02',
        'rollout-2026-07-02T09-00-00-029f0000-1111-7222-8333-555555555555.jsonl'
      ),
      jsonLines([
        {
          timestamp: '2026-07-02T09:00:00.000Z',
          type: 'session_meta',
          payload: { id: '029f0000-1111-7222-8333-555555555555', cwd: '/repo/app' }
        },
        {
          timestamp: '2026-07-02T09:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Managed-only session' }]
          }
        }
      ])
    )

    const result = await scanAiVaultSessions({
      ...roots,
      codexSessionsDir: realSessionsDir,
      defaultCodexHomeDir: realHome,
      additionalCodexSessionsDirs: [managedSessionsDir],
      platform: 'darwin'
    })

    expect(result.issues).toEqual([])
    const codexSessions = result.sessions.filter((session) => session.agent === 'codex')
    expect(codexSessions).toHaveLength(2)

    const backfilled = codexSessions.find(
      (session) => session.sessionId === '019f0000-1111-7222-8333-444444444444'
    )
    expect(backfilled).toMatchObject({
      codexHome: null,
      filePath: join(realSessionsDir, '2026', '07', '01', rolloutName),
      resumeCommand: "cd '/repo/app' && codex resume '019f0000-1111-7222-8333-444444444444'"
    })
    expect(backfilled?.resumeCommand).not.toContain('CODEX_HOME')

    const managedOnly = codexSessions.find(
      (session) => session.sessionId === '029f0000-1111-7222-8333-555555555555'
    )
    expect(managedOnly).toMatchObject({
      codexHome: managedHome,
      resumeCommand: `cd '/repo/app' && CODEX_HOME='${managedHome}' codex resume '029f0000-1111-7222-8333-555555555555'`
    })
  })

  it('keeps different same-name rollouts from separate roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-collision-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const realHome = join(root, 'real-codex-home')
    const realSessionsDir = join(realHome, 'sessions')
    const managedHome = join(root, 'codex-runtime-home', 'home')
    const managedSessionsDir = join(managedHome, 'sessions')
    const rolloutName = 'rollout-2026-07-01T10-00-00-collision.jsonl'
    const realPath = join(realSessionsDir, rolloutName)
    const managedPath = join(managedSessionsDir, rolloutName)
    await mkdir(realSessionsDir, { recursive: true })
    await mkdir(managedSessionsDir, { recursive: true })
    await writeFile(
      realPath,
      jsonLines([
        {
          timestamp: '2026-07-01T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'real-session', cwd: '/repo/real' }
        },
        {
          timestamp: '2026-07-01T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Real content' }]
          }
        }
      ])
    )
    await writeFile(
      managedPath,
      jsonLines([
        {
          timestamp: '2026-07-01T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'managed-session', cwd: '/repo/managed' }
        },
        {
          timestamp: '2026-07-01T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Managed content' }]
          }
        }
      ])
    )

    const result = await scanAiVaultSessions({
      ...roots,
      codexSessionsDir: realSessionsDir,
      defaultCodexHomeDir: realHome,
      additionalCodexSessionsDirs: [managedSessionsDir],
      platform: 'darwin'
    })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.sessionId).sort()).toEqual([
      'managed-session',
      'real-session'
    ])
  })

  it('fills the listing past cross-volume-style copy aliases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-copy-cap-'))
    tempRoots.push(root)
    const roots = isolatedScanRoots(root)
    const realHome = join(root, 'real-codex-home')
    const realSessionsDir = join(realHome, 'sessions')
    const managedHome = join(root, 'codex-runtime-home', 'home')
    const managedSessionsDir = join(managedHome, 'sessions')
    const aliasName = 'rollout-2026-07-02T10-00-00-copy-alias.jsonl'
    const realAliasPath = join(realSessionsDir, aliasName)
    const managedAliasPath = join(managedSessionsDir, aliasName)
    const uniquePath = join(managedSessionsDir, 'rollout-2026-07-01T10-00-00-unique.jsonl')
    await mkdir(realSessionsDir, { recursive: true })
    await mkdir(managedSessionsDir, { recursive: true })
    await writeFile(
      realAliasPath,
      jsonLines([
        {
          timestamp: '2026-07-02T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'copied-session', cwd: '/repo/copied' }
        },
        {
          timestamp: '2026-07-02T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Copied content' }]
          }
        }
      ])
    )
    await copyFile(realAliasPath, managedAliasPath)
    await writeFile(
      uniquePath,
      jsonLines([
        {
          timestamp: '2026-07-01T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'unique-session', cwd: '/repo/unique' }
        },
        {
          timestamp: '2026-07-01T10:00:01.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'text', text: 'Unique content' }]
          }
        }
      ])
    )
    const newest = new Date('2026-07-02T10:00:00.000Z')
    const older = new Date('2026-07-01T10:00:00.000Z')
    await utimes(realAliasPath, newest, newest)
    await utimes(managedAliasPath, newest, newest)
    await utimes(uniquePath, older, older)

    const result = await scanAiVaultSessions({
      ...roots,
      codexSessionsDir: realSessionsDir,
      defaultCodexHomeDir: realHome,
      additionalCodexSessionsDirs: [managedSessionsDir],
      platform: 'darwin',
      limit: 2
    })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.sessionId).sort()).toEqual([
      'copied-session',
      'unique-session'
    ])
    expect(result.sessions.find((session) => session.sessionId === 'copied-session')).toMatchObject(
      {
        codexHome: null,
        filePath: realAliasPath
      }
    )
  })
})

async function canonicalCopies(nonUser = false) {
  const root = await mkdtemp(join(tmpdir(), 'orca-canonical-choice-'))
  tempRoots.push(root)
  const realHome = join(root, 'real-home')
  const managedHome = join(root, 'codex-accounts', 'account', 'home')
  const name = 'rollout-2026-07-01T10-00-00-019f0000-1111-7222-8333-444444444444.jsonl'
  const real = join(realHome, 'sessions', name)
  const managed = join(managedHome, 'sessions', name)
  await mkdir(join(realHome, 'sessions'), { recursive: true })
  await mkdir(join(managedHome, 'sessions'), { recursive: true })
  await writeFile(
    real,
    jsonLines([
      {
        type: 'session_meta',
        payload: {
          id: '019f0000-1111-7222-8333-444444444444',
          cwd: '/repo/app',
          ...(nonUser ? { source: { internal: 'guardian_review' } } : {})
        }
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'readablealiasneedle' }]
        }
      }
    ])
  )
  await appendFile(real, '\n')
  await copyFile(real, managed)
  return {
    real,
    managed,
    managedHome,
    options: {
      ...isolatedScanRoots(root),
      codexSessionsDir: join(realHome, 'sessions'),
      defaultCodexHomeDir: realHome,
      additionalCodexSessionsDirs: [join(managedHome, 'sessions')],
      platform: 'darwin' as const,
      limit: 1
    }
  }
}

it('falls back to a readable canonical copy with its own resume ownership, then recovers the real home', async () => {
  const fixture = await canonicalCopies()
  reads.failed = fixture.real
  const first = await scanAiVaultSessions(fixture.options)
  expect(first.sessions).toHaveLength(1)
  expect(first.sessions[0]).toMatchObject({
    filePath: fixture.managed,
    codexHome: fixture.managedHome,
    title: 'readablealiasneedle'
  })
  expect(first.sessions[0].resumeCommand).toContain(`CODEX_HOME='${fixture.managedHome}'`)
  reads.failed = ''
  const recovered = await scanAiVaultSessions(fixture.options)
  expect(recovered.sessions).toHaveLength(1)
  expect(recovered.sessions[0]).toMatchObject({ filePath: fixture.real, codexHome: null })
})

it('does not open an alternate after cancellation', async () => {
  const fixture = await canonicalCopies()
  reads.failed = fixture.real
  reads.cancel = new AbortController()
  await expect(
    scanAiVaultSessions({ ...fixture.options, signal: reads.cancel.signal })
  ).rejects.toThrow()
  expect(reads.paths).not.toContain(fixture.managed)
})

it('excludes a canonical non-user rollout after one physical attempt', async () => {
  const fixture = await canonicalCopies(true)
  expect((await scanAiVaultSessions(fixture.options)).sessions).toEqual([])
  expect(reads.paths).toEqual([fixture.real])
})

it('tries readable content after a provisional filename-only row', async () => {
  const fixture = await canonicalCopies()
  await writeFile(fixture.real, '{}\n')
  const result = await scanAiVaultSessions(fixture.options)
  expect(result.sessions).toHaveLength(1)
  expect(result.sessions[0]).toMatchObject({
    filePath: fixture.managed,
    title: 'readablealiasneedle'
  })
})

it('keeps distinct canonical rollouts and execution namespaces, preferring nonempty copies', async () => {
  const name = 'rollout-2026-07-01T10-00-00-019f0000-1111-7222-8333-444444444444'
  const paths = [
    `/real/${name}.jsonl`,
    `/managed/${name}.jsonl`,
    `/real/${name}_019f0000-2222-7222-8333-444444444444.jsonl`,
    `\\\\wsl.localhost\\Ubuntu\\home\\neil\\${name}.jsonl`
  ]
  const candidates = await sessionCandidatesFromDiscoveries(
    [
      {
        agent: 'codex',
        rootDir: '/real',
        files: paths.map((path, i) => ({
          path,
          mtimeMs: 1,
          modifiedAt: '2026-07-01T10:00:00Z',
          sizeBytes: i === 0 ? 0 : 100
        }))
      }
    ],
    {}
  )
  expect(candidates.map((choice) => choice.file.path).sort()).toEqual(paths.slice(1).sort())
  expect(
    candidates
      .find((choice) => choice.file.path === paths[1])
      ?.alternatives?.map((candidate) => candidate.file.path)
  ).toEqual([paths[1], paths[0]])
})

it('falls back when a growing cached preferred file fails its resume boundary read', async () => {
  const fixture = await canonicalCopies()
  expect((await scanAiVaultSessions(fixture.options)).sessions[0].filePath).toBe(fixture.real)
  await appendFile(
    fixture.real,
    jsonLines([
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'newaliasmessage' }]
        }
      }
    ])
  )
  await appendFile(fixture.real, '\n')
  await copyFile(fixture.real, fixture.managed)
  reads.failedSlice = fixture.real
  const result = await scanAiVaultSessions(fixture.options)
  expect(result.sessions).toHaveLength(1)
  expect(result.sessions[0]).toMatchObject({ filePath: fixture.managed, messageCount: 2 })
})

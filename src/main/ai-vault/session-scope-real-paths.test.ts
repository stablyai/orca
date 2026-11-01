import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'
import {
  attachAiVaultScopeCwdAliases,
  resolveAiVaultScopeRealPaths
} from './session-scope-real-paths'

let root: string
let realRepo: string
let linkedRepo: string

// Junctions need no Windows symlink privilege; elsewhere the type is ignored.
const linkDir = (target: string, path: string): Promise<void> => symlink(target, path, 'junction')

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-scope-real-paths-')))
  realRepo = join(root, 'data', 'api')
  linkedRepo = join(root, 'work-api')
  await mkdir(join(realRepo, 'pkg'), { recursive: true })
  await linkDir(realRepo, linkedRepo)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function session(id: string, cwd: string | null, filePath = `/sessions/${id}.jsonl`) {
  return {
    id,
    executionHostId: 'local',
    agent: 'codex',
    sessionId: id,
    title: id,
    cwd,
    branch: null,
    model: null,
    filePath,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-10-20T00:00:00.000Z',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: id,
    subagent: null
  } satisfies AiVaultSession
}

function result(sessions: AiVaultSession[]): AiVaultListResult {
  return { sessions, issues: [], scannedAt: '2026-10-20T00:00:00.000Z' }
}

describe('resolveAiVaultScopeRealPaths', () => {
  it('adds the real path of a symlinked scope so the scan admits sessions recorded there', async () => {
    const scope = await resolveAiVaultScopeRealPaths([linkedRepo, realRepo, join(root, 'gone')])

    expect(scope.scanScopePaths).toEqual([linkedRepo, realRepo, join(root, 'gone')])
    expect(scope.links).toEqual([{ scopePath: linkedRepo, realPath: realRepo }])
  })

  it('skips paths this host does not have and paths that are not links', async () => {
    const scope = await resolveAiVaultScopeRealPaths([realRepo, join(root, 'other-host-path')])

    expect(scope.links).toEqual([])
    expect(scope.scanScopePaths).toEqual([realRepo, join(root, 'other-host-path')])
  })
})

describe('attachAiVaultScopeCwdAliases', () => {
  it('aliases cwds under the real path to the registered spelling and keeps cwd for resume', async () => {
    const scope = await resolveAiVaultScopeRealPaths([linkedRepo])
    const listed = attachAiVaultScopeCwdAliases(
      result([session('real', realRepo), session('nested', join(realRepo, 'pkg'))]),
      scope
    )

    expect(listed.sessions.map((entry) => [entry.cwd, entry.cwdAliases])).toEqual([
      [realRepo, [linkedRepo]],
      [join(realRepo, 'pkg'), [join(linkedRepo, 'pkg')]]
    ])
  })

  it('never resolves a recorded cwd, so a cwd spelled through another link stays unmatched', async () => {
    const otherLink = join(root, 'other-link')
    await linkDir(realRepo, otherLink)
    const rows = [session('other-link', join(otherLink, 'pkg'))]

    const listed = attachAiVaultScopeCwdAliases(
      result(rows),
      await resolveAiVaultScopeRealPaths([linkedRepo])
    )

    expect(listed.sessions).toEqual(rows)
  })

  it('leaves unrelated, cwd-less and WSL rows untouched', async () => {
    const scope = await resolveAiVaultScopeRealPaths([linkedRepo])
    const rows = [
      session('unrelated', join(root, 'elsewhere')),
      session('no-cwd', null),
      session('wsl', '/data/api', '\\\\wsl.localhost\\Ubuntu\\home\\me\\.codex\\s.jsonl')
    ]
    const listed = attachAiVaultScopeCwdAliases(result(rows), scope)

    expect(listed.sessions).toEqual(rows)
  })
})

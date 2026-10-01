import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { resetRemoteSessionParseCacheForTests } from './remote-session-parse-cache'
import { scanRemoteAiVaultSessions } from './remote-session-scanner'
import { MemoryRemoteProvider, jsonLines } from './remote-session-scanner-test-fixtures'
import type { RemoteOpenCodeSessionReader } from './remote-session-scanner-types'
import { createAccumulator, finalizeSession, updateTimeline } from './session-scanner-accumulator'
import {
  buildOpenCodeSqliteCandidatePath,
  splitOpenCodeSqliteCandidate
} from './session-scanner-opencode-sqlite-paths'
import type { FileWithMtime } from './session-scanner-types'

const remoteHome = '/home/ada'
const dataDirectory = `${remoteHome}/.local/share/opencode`
const hostPlatform = getRemoteHostPlatform('linux-x64')
const scanOptions = { remoteHome, hostPlatform, executionHostId: 'ssh:one' as const }

beforeEach(resetRemoteSessionParseCacheForTests)

function fixture() {
  const sessions = new Map<string, AiVaultSession>()
  const list: RemoteOpenCodeSessionReader['list'] = vi.fn(async (args) =>
    [...sessions.values()]
      .filter(
        (session) =>
          session.agent === (args.agent ?? 'opencode') && args.dbPaths.includes(session.filePath)
      )
      .sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt))
      .slice(0, args.limit)
      .map((session) => ({
        agent: session.agent,
        codexHome: null,
        file: file(
          buildOpenCodeSqliteCandidatePath(session.filePath, session.sessionId),
          Date.parse(session.modifiedAt)
        )
      }))
  )
  const parse: RemoteOpenCodeSessionReader['parse'] = vi.fn(
    async (args) =>
      sessions.get(
        `${args.agent ?? 'opencode'}:${buildOpenCodeSqliteCandidatePath(args.dbPath, args.sessionId)}`
      ) ?? null
  )
  const parseLegacy = vi.fn(async (entry: FileWithMtime) =>
    session('opencode', 'legacy', entry, '/home/ada/repo')
  )
  const provider = Object.assign(new MemoryRemoteProvider(), {
    openCode: { dataDirectory, list, parse, parseLegacy }
  })
  const add = (
    id: string,
    mtime: number,
    options: { agent?: 'opencode' | 'opencode2'; cwd?: string; dbName?: string } = {}
  ) => {
    const agent = options.agent ?? 'opencode'
    const dbPath = `${dataDirectory}/${options.dbName ?? 'opencode.db'}`
    provider.addFile(dbPath, 'database', 1)
    const path = buildOpenCodeSqliteCandidatePath(dbPath, id)
    sessions.set(
      `${agent}:${path}`,
      session(agent, id, file(path, mtime), options.cwd ?? '/home/ada/other')
    )
  }
  return { provider, add, list, parse, parseLegacy }
}

function file(path: string, mtimeMs: number): FileWithMtime {
  return { path, mtimeMs, modifiedAt: new Date(mtimeMs).toISOString() }
}

function session(
  agent: 'opencode' | 'opencode2',
  sessionId: string,
  entry: FileWithMtime,
  cwd: string
): AiVaultSession {
  const accumulator = createAccumulator({
    agent,
    file: { ...entry, path: splitOpenCodeSqliteCandidate(entry.path)?.dbPath ?? entry.path },
    sessionId
  })
  accumulator.cwd = cwd
  updateTimeline(accumulator, entry.modifiedAt)
  const parsed = finalizeSession(accumulator, 'linux')
  if (!parsed) {
    throw new Error('Invalid fixture session')
  }
  return parsed
}

describe('remote OpenCode discovery', () => {
  it('sorts database rows with file-backed agents before applying the global cap', async () => {
    const { provider, add } = fixture()
    add('older', 1000)
    add('newest', 3000)
    provider.addFile(
      `${remoteHome}/.claude/projects/project/middle.jsonl`,
      jsonLines([
        {
          sessionId: 'middle',
          timestamp: new Date(2000).toISOString(),
          type: 'user',
          message: { content: 'middle' }
        }
      ]),
      2000
    )
    const read = vi.spyOn(provider, 'readFile')
    const result = await scanRemoteAiVaultSessions({ ...scanOptions, provider, limit: 2 })
    expect(result.issues).toEqual([])
    expect(result.sessions.map((entry) => entry.sessionId)).toEqual(['newest', 'middle'])
    expect(result.sessions[0]).toMatchObject({
      executionHostId: 'ssh:one',
      executionHostPlatform: 'linux',
      id: `ssh:one:opencode:newest:${dataDirectory}/opencode.db`
    })
    expect(read.mock.calls.every(([path]) => !path.includes('.db#'))).toBe(true)
  })

  it('retains older scoped rows beyond the recent parse budget', async () => {
    const { provider, add, list } = fixture()
    for (let index = 0; index < 10; index++) {
      add(`other-${index}`, 10000 + index)
    }
    add('scoped', 1000, { cwd: '/home/ada/repo/app' })
    const result = await scanRemoteAiVaultSessions({
      ...scanOptions,
      provider,
      limit: 1,
      scopePaths: ['/home/ada/repo']
    })
    expect(result.sessions.map((entry) => entry.sessionId)).toEqual(['other-9', 'scoped'])
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ limit: 1003 }))
  })

  it('drops stale legacy duplicates before limiting while keeping legacy-only history', async () => {
    const { provider, add, parseLegacy } = fixture()
    add('migrated', 2000)
    provider.addFile(`${dataDirectory}/storage/session/project/migrated.json`, '{}', 9000)
    provider.addFile(`${dataDirectory}/storage/session/project/legacy.json`, '{}', 1000)
    const result = await scanRemoteAiVaultSessions({ ...scanOptions, provider, limit: 10 })
    expect(result.sessions.map((entry) => entry.sessionId)).toEqual(['migrated', 'legacy'])
    expect(parseLegacy).toHaveBeenCalledTimes(1)
    expect(parseLegacy).toHaveBeenCalledWith(
      expect.objectContaining({ path: expect.stringContaining('/legacy.json') }),
      'linux'
    )
  })

  it('keeps v1 and v2 identities separate in a shared database and parse cache', async () => {
    const { provider, add, parse, list } = fixture()
    add('same-id', 2000)
    add('same-id', 2000, { agent: 'opencode2' })
    add('beta', 1000, { agent: 'opencode2', dbName: 'opencode-next.db' })
    const first = await scanRemoteAiVaultSessions({ ...scanOptions, provider })
    const second = await scanRemoteAiVaultSessions({ ...scanOptions, provider })
    expect(first.sessions.map((entry) => entry.agent).sort()).toEqual([
      'opencode',
      'opencode2',
      'opencode2'
    ])
    expect(second.sessions).toEqual(first.sessions)
    expect(parse).toHaveBeenCalledTimes(3)
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ dbPaths: [`${dataDirectory}/opencode.db`] })
    )
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        dbPaths: [`${dataDirectory}/opencode-next.db`, `${dataDirectory}/opencode.db`],
        agent: 'opencode2'
      })
    )
  })

  it('invalidates cached database rows after updates and across hosts', async () => {
    const { provider, add, parse } = fixture()
    add('session', 1000)
    await scanRemoteAiVaultSessions({ ...scanOptions, provider })
    add('session', 2000)
    const updated = await scanRemoteAiVaultSessions({ ...scanOptions, provider })
    const other = await scanRemoteAiVaultSessions({
      ...scanOptions,
      executionHostId: 'ssh:two',
      provider
    })
    expect(parse).toHaveBeenCalledTimes(3)
    expect(updated.sessions[0]?.modifiedAt).toBe(new Date(2000).toISOString())
    expect(other.sessions[0]?.executionHostId).toBe('ssh:two')
  })

  it('propagates cancellation into the reader and does not cache cancelled parses', async () => {
    const { provider, add, parse } = fixture()
    add('session', 1000)
    const controller = new AbortController()
    provider.openCode.parse = async (args) => {
      expect(args.signal).toBe(controller.signal)
      controller.abort()
      return parse(args)
    }
    await expect(
      scanRemoteAiVaultSessions({ ...scanOptions, provider, signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    provider.openCode.parse = parse
    await scanRemoteAiVaultSessions({ ...scanOptions, provider })
    expect(parse).toHaveBeenCalledTimes(2)
  })

  it('leaves legacy filesystem providers on their existing fallback', async () => {
    const provider = new MemoryRemoteProvider()
    provider.addFile(`${dataDirectory}/opencode.db`, 'database', 1000)
    const result = await scanRemoteAiVaultSessions({ ...scanOptions, provider })
    expect(result.sessions).toEqual([])
    expect(result.issues).toEqual([])
    expect(provider.readDirPaths).not.toContain(dataDirectory)
  })

  it('honors an explicitly configured database symlink without enumerating sibling databases', async () => {
    const { provider, add, list } = fixture()
    add('selected', 1000, { dbName: 'opencode-team.db' })
    add('other', 2000)
    const selected = `${dataDirectory}/opencode-team.db`
    Object.assign(provider.openCode, { databasePath: selected })
    const stat = provider.stat.bind(provider)
    vi.spyOn(provider, 'stat').mockImplementation(async (path) =>
      path === selected ? { type: 'symlink', size: 20, mtime: 1000, mtimeMs: 1000 } : stat(path)
    )
    const result = await scanRemoteAiVaultSessions({ ...scanOptions, provider })
    expect(result.sessions.map((entry) => entry.sessionId)).toEqual(['selected'])
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ dbPaths: [selected] }))
    expect(provider.readDirPaths).not.toContain(dataDirectory)
  })
})

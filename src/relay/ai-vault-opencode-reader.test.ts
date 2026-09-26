import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultScanIssue } from '../shared/ai-vault-types'
import { getRemoteHostPlatform } from '../main/ssh/ssh-remote-platform'
import { scanRemoteAiVaultSessions } from '../main/ai-vault/remote-session-scanner'
import { resetRemoteSessionParseCacheForTests } from '../main/ai-vault/remote-session-parse-cache'
import { listOpenCodeSqliteSessions } from '../main/ai-vault/session-scanner-opencode-sqlite-list'
import { listOpenCode2SqliteSessions } from '../main/ai-vault/session-scanner-opencode2-sqlite-list'
import { parseOpenCodeSqliteSession } from '../main/ai-vault/session-scanner-opencode-sqlite'
import { parseOpenCode2SqliteSession } from '../main/ai-vault/session-scanner-opencode2-sqlite'
import { writeOpenCodeSqliteDatabase } from '../main/ai-vault/session-scanner-opencode-sqlite-fixture'
import { createRelayAiVaultFilesystemProvider } from './ai-vault-service-filesystem'
import {
  createRelayOpenCodeReader,
  type RelayOpenCodeReaderOptions
} from './ai-vault-opencode-reader'

const directories: string[] = []
const disposables: { dispose(): void }[] = []

afterEach(async () => {
  for (const disposable of disposables.splice(0)) {
    disposable.dispose()
  }
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  resetRemoteSessionParseCacheForTests()
})

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'orca-relay-opencode-'))
  directories.push(path)
  return path
}

function factory() {
  const reader = { list: vi.fn(async () => []), parse: vi.fn(async () => null), dispose: vi.fn() }
  return {
    reader,
    create: vi.fn(
      (_options: Parameters<NonNullable<RelayOpenCodeReaderOptions['readerFactory']>>[0]) => reader
    )
  }
}

describe('relay OpenCode reader', () => {
  it('coalesces a persistent reader selected by the provisioned runtime reference', async () => {
    const baseDir = await temporaryDirectory()
    const executable = join(baseDir, 'runtime', 'bun')
    await writeFile(
      join(baseDir, 'opencode-sqlite-runtime.json'),
      JSON.stringify({ protocol: 1, executable })
    )
    const { reader, create } = factory()
    const probe = vi.fn(() => false)
    const provider = createRelayAiVaultFilesystemProvider({
      baseDir,
      readerFactory: create,
      canReadSqlite: probe,
      environment: {
        HOME: baseDir,
        NODE_OPTIONS: '--require=bad',
        XDG_DATA_HOME: join(baseDir, 'data')
      }
    })
    disposables.push(provider)
    const issues: AiVaultScanIssue[] = []
    const args = { dbPaths: [join(baseDir, 'opencode.db')], limit: 10, issues }
    await Promise.all([provider.openCode?.list(args), provider.openCode?.list(args)])
    expect(issues).toEqual([])
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ executable, args: [join(baseDir, 'opencode-sqlite-reader.cjs')] })
    )
    expect(create.mock.calls[0]?.[0]?.env?.NODE_OPTIONS).toBeUndefined()
    expect(probe).not.toHaveBeenCalled()
    provider.dispose()
    expect(reader.dispose).toHaveBeenCalledTimes(1)
  })

  it('reports an unavailable reader once per source and retries after provisioning', async () => {
    const baseDir = await temporaryDirectory()
    const { create } = factory()
    const reader = createRelayOpenCodeReader({
      baseDir,
      readerFactory: create,
      canReadSqlite: () => false
    })
    disposables.push(reader)
    const issues: AiVaultScanIssue[] = []
    const args = {
      dbPaths: [join(baseDir, 'opencode.db'), join(baseDir, 'opencode-other.db')],
      limit: 10,
      issues
    }
    await reader.list(args)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      agent: 'opencode',
      kind: 'scope',
      message: expect.stringContaining('waiting')
    })
    expect(create).not.toHaveBeenCalled()
    await writeFile(
      join(baseDir, 'opencode-sqlite-runtime.json'),
      JSON.stringify({ protocol: 1, executable: join(baseDir, 'bun') })
    )
    await reader.list({ ...args, issues: [] })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('uses the current runtime only after a successful SQLite read probe', async () => {
    const baseDir = await temporaryDirectory()
    const { create } = factory()
    const reader = createRelayOpenCodeReader({
      baseDir,
      readerFactory: create,
      currentExecutable: process.execPath
    })
    disposables.push(reader)
    const issues: AiVaultScanIssue[] = []
    await reader.list({ dbPaths: [join(baseDir, 'opencode.db')], limit: 1, issues })
    expect(issues).toEqual([])
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ executable: process.execPath }))
  })

  it('replaces the persistent reader after a repaired runtime reference changes', async () => {
    const baseDir = await temporaryDirectory()
    const referencePath = join(baseDir, 'opencode-sqlite-runtime.json')
    await writeFile(
      referencePath,
      JSON.stringify({ protocol: 1, executable: join(baseDir, 'old-bun') })
    )
    const first = factory()
    const second = factory()
    const create = vi
      .fn<NonNullable<RelayOpenCodeReaderOptions['readerFactory']>>()
      .mockReturnValueOnce(first.reader)
      .mockReturnValueOnce(second.reader)
    const reader = createRelayOpenCodeReader({ baseDir, readerFactory: create })
    disposables.push(reader)
    const args = { dbPaths: [join(baseDir, 'opencode.db')], limit: 1, issues: [] }
    await reader.list(args)
    await writeFile(
      referencePath,
      JSON.stringify({ protocol: 1, executable: join(baseDir, 'repaired-bun') })
    )
    await reader.list(args)
    expect(first.reader.dispose).toHaveBeenCalledOnce()
    expect(second.reader.list).toHaveBeenCalledOnce()
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({ executable: join(baseDir, 'repaired-bun') })
    )
  })

  it.each([
    { protocol: 2, executable: '/runtime/bun' },
    { protocol: 1, executable: 'bun' },
    { protocol: 1, executable: '/runtime/bun\0bad' }
  ])('refuses an invalid runtime reference: %j', async (reference) => {
    const baseDir = await temporaryDirectory()
    await writeFile(join(baseDir, 'opencode-sqlite-runtime.json'), JSON.stringify(reference))
    const { create } = factory()
    const reader = createRelayOpenCodeReader({
      baseDir,
      readerFactory: create,
      canReadSqlite: () => true
    })
    disposables.push(reader)
    const issues: AiVaultScanIssue[] = []
    await reader.list({ dbPaths: ['opencode.db'], limit: 1, issues })
    expect(issues).toHaveLength(1)
    expect(create).not.toHaveBeenCalled()
  })

  it('retains the host database overrides including relative and in-memory paths', async () => {
    const baseDir = await temporaryDirectory()
    const data = join(baseDir, 'data')
    const reader = createRelayOpenCodeReader({
      baseDir,
      environment: { XDG_DATA_HOME: data, OPENCODE_DB: 'opencode-team.db' }
    })
    expect(reader.dataDirectory).toBe(join(data, 'opencode'))
    expect(reader.databasePath).toBe(join(data, 'opencode', 'opencode-team.db'))
    expect(
      createRelayOpenCodeReader({ environment: { OPENCODE_DB: ':memory:' } }).databasePath
    ).toBeNull()
  })

  it('does not start a child for empty or cancelled scans', async () => {
    const baseDir = await temporaryDirectory()
    const { create } = factory()
    const reader = createRelayOpenCodeReader({ baseDir, readerFactory: create })
    disposables.push(reader)
    await reader.list({ dbPaths: [], limit: 1, issues: [] })
    const controller = new AbortController()
    controller.abort()
    await expect(
      reader.list({ dbPaths: ['opencode.db'], limit: 1, issues: [], signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(create).not.toHaveBeenCalled()
  })

  it('scans the host database and legacy JSON through the existing readers', async () => {
    const baseDir = await temporaryDirectory()
    const xdg = join(baseDir, 'data')
    const dbPath = join(xdg, 'opencode', 'opencode-team.db')
    writeOpenCodeSqliteDatabase(dbPath, [
      { id: 'migrated', turns: [{ role: 'user', parts: ['Database prompt'] }] }
    ])
    const sessionDir = join(xdg, 'opencode', 'storage', 'session', 'project')
    await mkdir(sessionDir, { recursive: true })
    await writeFile(
      join(sessionDir, 'migrated.json'),
      JSON.stringify({ id: 'migrated', title: 'Stale title' })
    )
    await writeFile(
      join(sessionDir, 'legacy.json'),
      JSON.stringify({ id: 'legacy', title: 'Legacy title', directory: '/project' })
    )
    const readerFactory: NonNullable<RelayOpenCodeReaderOptions['readerFactory']> = () => ({
      list: (args) =>
        args.agent === 'opencode2'
          ? listOpenCode2SqliteSessions(args)
          : listOpenCodeSqliteSessions(args),
      parse: async (args) =>
        args.agent === 'opencode2'
          ? parseOpenCode2SqliteSession(args)
          : parseOpenCodeSqliteSession(args),
      dispose() {}
    })
    const provider = createRelayAiVaultFilesystemProvider({
      baseDir,
      environment: { XDG_DATA_HOME: xdg, OPENCODE_DB: 'opencode-team.db' },
      readerFactory
    })
    disposables.push(provider)
    const result = await scanRemoteAiVaultSessions({
      provider,
      remoteHome: baseDir,
      executionHostId: 'ssh:actual',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })
    expect(result.issues).toEqual([])
    expect(result.sessions.map((entry) => entry.sessionId).sort()).toEqual(['legacy', 'migrated'])
    expect(result.sessions.find((entry) => entry.sessionId === 'migrated')).toMatchObject({
      filePath: dbPath,
      executionHostId: 'ssh:actual',
      previewMessages: [expect.objectContaining({ text: 'Database prompt' })]
    })
  })
})

import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FOREIGN_SQLITE_READER_ENTRY_FILENAME as ENTRY } from '../foreign-sqlite-readers/foreign-sqlite-reader-entry-path'
import type * as OpenCodeWslClient from './session-scanner-opencode-wsl-client'
import type { OpenCodeSqliteWorkerClient } from './session-scanner-opencode-sqlite-worker-client'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import {
  resolveOpenCodeSqliteWorkerEntryPath,
  listOpenCodeSqliteSessionsViaWorker
} from './session-scanner-opencode-sqlite-worker-spawn'

describe('resolveOpenCodeSqliteWorkerEntryPath', () => {
  it('resolves a worker adjacent to an entry bundle', () => {
    const runtimeDir = join('out', 'main')
    const expected = join(runtimeDir, ENTRY)

    expect(resolveOpenCodeSqliteWorkerEntryPath(runtimeDir, (path) => path === expected)).toBe(
      expected
    )
  })

  it('resolves a root worker from a shared Rollup chunk', () => {
    const runtimeDir = join('out', 'main', 'chunks')
    const expected = join('out', 'main', ENTRY)

    expect(resolveOpenCodeSqliteWorkerEntryPath(runtimeDir, (path) => path === expected)).toBe(
      expected
    )
  })
})

const mocks = vi.hoisted(() => ({ list: vi.fn<OpenCodeSqliteWorkerClient['list']>() }))
vi.mock('./session-scanner-opencode-wsl-client', async (importOriginal) => {
  const { parseWslUncPath } = await import('../../shared/wsl-paths')
  return {
    ...(await importOriginal<typeof OpenCodeWslClient>()),
    openCodeWslPath: parseWslUncPath,
    openCodeWslClient: async () => ({ list: mocks.list })
  }
})

it('routes scoped SQLite reads only to the owning distro and reports a scoped-only failure', async () => {
  const ubuntu = String.raw`\\wsl.localhost\Ubuntu\home\ada\opencode.db`
  const debian = String.raw`\\wsl.localhost\Debian\home\ada\opencode.db`
  const issues: AiVaultScanIssue[] = []
  mocks.list.mockImplementation(async (args) => {
    if (args.scopePaths?.length) {
      expect(args.scopePaths).toEqual(['/home/ada/repo'])
      args.issues.push({
        agent: 'opencode',
        kind: 'scope',
        path: args.dbPaths[0],
        message: 'Scoped read timed out'
      })
    }
    return []
  })
  await listOpenCodeSqliteSessionsViaWorker({ dbPaths: [ubuntu], limit: 1, issues })
  await listOpenCodeSqliteSessionsViaWorker({
    dbPaths: [ubuntu, debian],
    limit: 1,
    issues,
    scopePaths: [String.raw`\\wsl.localhost\Ubuntu\home\ada\repo`]
  })
  expect(mocks.list).toHaveBeenCalledTimes(2)
  expect(issues).toEqual([
    { agent: 'opencode', kind: 'scope', path: ubuntu, message: 'Scoped read timed out' }
  ])
})

it('translates the exact selected SQLite identity only within its known WSL source', async () => {
  mocks.list.mockClear().mockResolvedValue([])
  const path = String.raw`\\wsl.localhost\Ubuntu\home\ada\opencode.db`
  await listOpenCodeSqliteSessionsViaWorker({
    dbPaths: [path],
    limit: 1,
    issues: [],
    selectedSessionId: `local:opencode:old:${path}#old`
  })
  expect(mocks.list).toHaveBeenCalledWith(
    expect.objectContaining({
      selectedSessionId: 'local:opencode:old:/home/ada/opencode.db#old',
      limit: 1
    })
  )
})

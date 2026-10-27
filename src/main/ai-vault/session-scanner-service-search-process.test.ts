import { spawnProcess } from '@orca/process-host'
import type { ChildProcessHandle } from '@orca/process-host/process-spec'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import type { AiVaultSearchResponse } from '../../shared/ai-vault-search-types'
import type { Repo } from '../../shared/repo-types'
import { SESSION_SEARCH_CANDIDATE_LIMIT_DEFAULT } from '../ai-vault-search/session-search-engine'
import {
  addSyntheticSession,
  markFork
} from '../ai-vault-search/session-search-engine-test-fixture'
import { openSessionSearchIndexerHarness } from '../ai-vault-search/session-search-indexer-test-fixture'
import { compileSessionSearchProjectOwnership } from '../ai-vault-search/session-search-project-ownership'
import { openSessionSearchDatabase } from '../ai-vault-search/session-search-schema'
import { AiVaultScannerServiceClient } from './session-scanner-service-client'
import { buildAiVaultServiceEnv } from './session-scanner-service-env'
import { isAiVaultServiceChildMessage } from './session-scanner-service-protocol'

it('serializes canonical ownership into a separate production scanner before native candidate caps and fork folding', async () => {
  const harness = await openSessionSearchIndexerHarness('sta10541-scanner-process')
  const home = join(harness.root, 'child-home')
  await mkdir(home)
  const executable =
    process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.env.npm_node_execpath ?? process.execPath
  const entry = resolve('src/main/ai-vault/session-scanner-service-entry.ts')
  const loader = createRequire(import.meta.url).resolve('tsx')
  let child: ChildProcessHandle | undefined
  let readyPid: number | undefined
  let closed: Promise<unknown> | undefined
  let stderr = ''
  const client = new AiVaultScannerServiceClient({
    processFactory: () => {
      expect(child).toBeUndefined()
      const startedAtMonotonicNs = process.hrtime.bigint().toString()
      child = spawnProcess({
        program: executable,
        args: ['--max-old-space-size=384', '--conditions=orca-source', '--import', loader, entry],
        serialization: 'json',
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: {
          ...buildAiVaultServiceEnv({ PATH: process.env.PATH, HOME: home, USERPROFILE: home }),
          ORCA_BACKGROUND_LAUNCH: '1',
          ORCA_DISABLE_MACOS_LOGIN_SHELL: '1',
          ORCA_E2E_USER_DATA_DIR: join(home, 'user-data'),
          ORCA_E2E_HOME_DIR: home,
          XDG_CONFIG_HOME: join(home, 'config'),
          XDG_CACHE_HOME: join(home, 'cache'),
          XDG_DATA_HOME: join(home, 'data'),
          CLAUDE_CONFIG_DIR: join(home, '.claude'),
          CODEX_HOME: join(home, '.codex')
        }
      })
      closed = once(child, 'close')
      child.on('message', (message: unknown) => {
        if (isAiVaultServiceChildMessage(message) && message.type === 'ready') {
          readyPid = message.pid
        }
      })
      console.info('scanner child ownership', {
        pid: child.pid,
        parentPid: process.pid,
        startedAtMonotonicNs,
        executable,
        entry
      })
      return child
    },
    resolveSessionSearchRoots: async () => harness.roots,
    init: () => ({
      sessionParseCache: null,
      sessionSearch: {
        databasePath: harness.databasePath,
        roots: harness.roots,
        settings: { enabled: true, historyDays: null }
      }
    }),
    onStderr: (text) => {
      stderr += text
    }
  })
  try {
    await client.request({ type: 'request', operation: 'searchReconcile' })
    expect(readyPid, stderr).toBe(child?.pid)
    expect(readyPid).toBeGreaterThan(0)
    expect(readyPid).not.toBe(process.pid)
    const repos: Repo[] = ['a', 'b'].map((id, index) => ({
      id,
      path: `/repos/${id}`,
      displayName: id,
      badgeColor: '',
      addedAt: index,
      upstream: { owner: 'acme', repo: 'app' }
    }))
    const selection = await compileSessionSearchProjectOwnership(
      {
        repos,
        projects: [],
        projectHostSetups: [],
        worktreeMeta: {},
        settings: { workspaceDir: '', nestWorkspaces: false }
      },
      'repo:b'
    )
    // Seed only after the child's initial real reconciliation; no parser or engine is replaced.
    const db = openSessionSearchDatabase(harness.databasePath)
    const target = SESSION_SEARCH_CANDIDATE_LIMIT_DEFAULT + 2
    try {
      db.exec('BEGIN')
      for (let id = 1; id < target; id++) {
        addSyntheticSession(db, {
          id,
          cwd: '/repos/a',
          text: 'childboundary',
          updatedAt: '2026-10-23'
        })
      }
      addSyntheticSession(db, {
        id: target,
        cwd: '/repos/b',
        text: 'childboundary',
        updatedAt: '2026-10-21'
      })
      addSyntheticSession(db, {
        id: target + 1,
        cwd: '/repos/b/topic',
        text: 'childboundary',
        updatedAt: '2026-10-20'
      })
      markFork(db, [1, target], 'shared-child-opening')
      db.exec('COMMIT')
    } finally {
      db.close()
    }
    const request = { query: 'childboundary', limit: 1, filters: { sort: 'newest' as const } }
    const legacy = await client.request<AiVaultSearchResponse>({
      type: 'request',
      operation: 'searchSessions',
      request
    })
    expect(legacy).toMatchObject({ kind: 'results', hits: [{ sessionId: '1' }] })
    const scoped = await client.request<AiVaultSearchResponse>({
      type: 'request',
      operation: 'searchSessions',
      request,
      hostScope: { kind: 'canonical', selection }
    })
    expect(scoped).toMatchObject({
      kind: 'results',
      hits: [{ sessionId: String(target) }],
      page: { hasMore: true }
    })
    if (scoped.kind !== 'results' || !scoped.page.cursor) {
      throw new Error(`Missing canonical child continuation: ${stderr}`)
    }
    expect(
      await client.request<AiVaultSearchResponse>({
        type: 'request',
        operation: 'searchSessions',
        request: { ...request, cursor: scoped.page.cursor },
        hostScope: { kind: 'canonical', selection }
      })
    ).toMatchObject({
      kind: 'results',
      hits: [{ sessionId: String(target + 1) }],
      page: { hasMore: false }
    })
  } finally {
    client.dispose()
    const force = setTimeout(() => {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
      }
    }, 5_000)
    try {
      await closed
      expect(child?.exitCode, stderr).toBe(0)
      expect(child?.signalCode, stderr).toBeNull()
    } finally {
      clearTimeout(force)
      await harness.cleanup()
    }
  }
})

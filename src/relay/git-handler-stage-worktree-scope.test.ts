import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { GitHandler } from './git-handler'
import { RelayContext } from './context'
import { DEFAULT_GIT_STATUS_LIMIT } from '../shared/git-status-limit'
import { RelayDispatcher } from '../wsl-guest/dispatcher'
import type { MethodHandler } from '../wsl-guest/dispatcher-contract'
import { gitCommit, gitInit } from './git-handler-test-setup'

const OVER_CAP = DEFAULT_GIT_STATUS_LIMIT + 50

function names(dir: string, args: string[]): string[] {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8' }).split('\n').filter(Boolean)
}

function fileName(i: number): string {
  return `big/f${String(i).padStart(5, '0')}.txt`
}

describe('GitHandler — bulkStage scope for a capped listing', () => {
  let dispatcher: RelayDispatcher
  let handlers: Map<string, MethodHandler>
  let tmpDir: string

  async function callRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const handler = handlers.get(method)
    if (!handler) {
      throw new Error(`No handler for ${method}`)
    }
    return handler(params, { clientId: 1, isStale: () => false })
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-git-stage-scope-'))
    dispatcher = new RelayDispatcher(() => {})
    handlers = new Map()
    vi.spyOn(dispatcher, 'onRequest').mockImplementation((method, handler) => {
      handlers.set(method, handler)
    })
    new GitHandler(dispatcher, new RelayContext())
    gitInit(tmpDir)
    mkdirSync(path.join(tmpDir, 'big'))
    for (let i = 0; i < OVER_CAP; i++) {
      writeFileSync(path.join(tmpDir, fileName(i)), 'a\n')
    }
    gitCommit(tmpDir, 'initial')
    for (let i = 0; i < OVER_CAP; i++) {
      writeFileSync(path.join(tmpDir, fileName(i)), 'b\n')
    }
    writeFileSync(path.join(tmpDir, 'zz-new.txt'), 'new\n')
  })

  afterEach(async () => {
    dispatcher.dispose()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function listedPaths(): Promise<string[]> {
    const status = await callRequest('git.status', { worktreePath: tmpDir })
    expect(status).toMatchObject({ didHitLimit: true })
    const entries =
      typeof status === 'object' && status && 'entries' in status ? status.entries : []
    return Array.isArray(entries) ? entries.map((entry) => String(entry.path)) : []
  }

  it('stages only the listed paths without a scope, leaving the rest unstaged', async () => {
    const reply = await callRequest('git.bulkStage', {
      worktreePath: tmpDir,
      filePaths: await listedPaths()
    })

    expect(reply).toBeUndefined()

    expect(names(tmpDir, ['diff', '--name-only'])).toHaveLength(OVER_CAP - DEFAULT_GIT_STATUS_LIMIT)
  })

  it('stages every change for scope all, beyond the capped listing', async () => {
    const reply = await callRequest('git.bulkStage', {
      worktreePath: tmpDir,
      filePaths: [],
      scope: 'all'
    })

    // The receipt is what tells a client this relay ran the scope rather than ignoring it.
    expect(reply).toEqual({ stagedScope: 'all' })

    expect(names(tmpDir, ['diff', '--name-only'])).toEqual([])
    expect(names(tmpDir, ['diff', '--cached', '--name-only'])).toHaveLength(OVER_CAP + 1)
  })

  it('stages tracked changes only for scope tracked', async () => {
    await callRequest('git.bulkStage', {
      worktreePath: tmpDir,
      filePaths: [],
      scope: 'tracked'
    })

    expect(names(tmpDir, ['diff', '--name-only'])).toEqual([])
    expect(names(tmpDir, ['ls-files', '--others', '--exclude-standard'])).toEqual(['zz-new.txt'])
  })

  it('ignores an unknown scope and stages the listed paths', async () => {
    await callRequest('git.bulkStage', {
      worktreePath: tmpDir,
      filePaths: [fileName(0)],
      scope: 'everything'
    })

    expect(names(tmpDir, ['diff', '--cached', '--name-only'])).toEqual(['big/f00000.txt'])
  })
})

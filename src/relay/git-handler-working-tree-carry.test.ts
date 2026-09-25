import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { GitHandler } from './git-handler'
import { RelayContext } from './context'
import {
  createMockDispatcher,
  gitInit,
  gitCommit,
  type MockDispatcher,
  type RelayDispatcher
} from './git-handler-test-setup'

describe('GitHandler — carry working tree changes', () => {
  let dispatcher: MockDispatcher
  let tmpDir: string
  let target: string

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-git-carry-'))
    target = path.join(tmpDir, '..', `${path.basename(tmpDir)}-child`)
    dispatcher = createMockDispatcher()
    new GitHandler(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: MockDispatcher implements the onRequest/onNotification/notify surface GitHandler registers against.
      dispatcher as unknown as RelayDispatcher,
      new RelayContext()
    )
  })

  afterEach(async () => {
    await fs.rm(target, { recursive: true, force: true })
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('carries uncommitted changes into a sibling worktree', async () => {
    gitInit(tmpDir)
    writeFileSync(path.join(tmpDir, 'tracked.txt'), 'base\n')
    gitCommit(tmpDir, 'base')
    execFileSync('git', ['worktree', 'add', '--quiet', '-b', 'child', target, 'HEAD'], {
      cwd: tmpDir,
      stdio: 'pipe'
    })
    writeFileSync(path.join(tmpDir, 'tracked.txt'), 'edited\n')
    writeFileSync(path.join(tmpDir, 'new.txt'), 'new\n')

    const result = await dispatcher.callRequest('git.carryWorkingTreeChanges', {
      sourceWorktreePath: tmpDir,
      targetWorktreePath: target
    })

    expect(result).toEqual({ ok: true, trackedChanges: true, untrackedCopied: 1 })
    expect(readFileSync(path.join(target, 'tracked.txt'), 'utf8')).toBe('edited\n')
    expect(readFileSync(path.join(target, 'new.txt'), 'utf8')).toBe('new\n')
    expect(readFileSync(path.join(tmpDir, 'tracked.txt'), 'utf8')).toBe('edited\n')
  })

  it('rejects a request without both worktree paths', async () => {
    await expect(
      dispatcher.callRequest('git.carryWorkingTreeChanges', { sourceWorktreePath: tmpDir })
    ).rejects.toThrow('carryWorkingTreeChanges requires source and target worktree paths')
  })
})

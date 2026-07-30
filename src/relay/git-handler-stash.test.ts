/**
 * Tests for GitHandler stash operations over the relay entrypoint.
 *
 * Why a dedicated file: stash is unreachable through git.exec (git-exec-validator
 * allows read-only subcommands only), so these dedicated methods are the SSH path
 * and need their own coverage against a real repo.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
import type { GitStashEntry } from '../shared/git-stash-types'

describe('GitHandler — stash', () => {
  let dispatcher: MockDispatcher
  let tmpDir: string

  function seedRepo(): void {
    gitInit(tmpDir)
    writeFileSync(path.join(tmpDir, 'tracked.txt'), 'base\n')
    gitCommit(tmpDir, 'initial')
  }

  async function listEntries(): Promise<GitStashEntry[]> {
    const result = (await dispatcher.callRequest('git.stashList', { worktreePath: tmpDir })) as {
      entries: GitStashEntry[]
    }
    return result.entries
  }

  function readTracked(): string {
    return readFileSync(path.join(tmpDir, 'tracked.txt'), 'utf-8')
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'relay-git-stash-'))
    dispatcher = createMockDispatcher()
    const ctx = new RelayContext()
    // eslint-disable-next-line no-new
    new GitHandler(dispatcher as unknown as RelayDispatcher, ctx)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('registers every stash method so an old client gets method-not-found, not silence', () => {
    for (const method of [
      'git.stashList',
      'git.stashPush',
      'git.stashApply',
      'git.stashPop',
      'git.stashDrop',
      'git.stashClear'
    ]) {
      expect(dispatcher._requestHandlers.has(method)).toBe(true)
    }
  })

  it('pushes, lists, and pops a stash', async () => {
    seedRepo()
    writeFileSync(path.join(tmpDir, 'tracked.txt'), 'edited\n')

    const pushed = await dispatcher.callRequest('git.stashPush', { worktreePath: tmpDir })
    expect(pushed).toEqual({ success: true, stashed: true })
    expect(readTracked()).toBe('base\n')

    const entries = await listEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].ref).toBe('stash@{0}')
    expect(entries[0].commitOid).toMatch(/^[0-9a-f]{40}$/)

    const popped = await dispatcher.callRequest('git.stashPop', { worktreePath: tmpDir })
    expect(popped).toEqual({ success: true })
    expect(readTracked()).toBe('edited\n')
    expect(await listEntries()).toEqual([])
  })

  it('reports nothing to stash without creating an entry', async () => {
    seedRepo()

    expect(await dispatcher.callRequest('git.stashPush', { worktreePath: tmpDir })).toEqual({
      success: true,
      stashed: false
    })
    expect(await listEntries()).toEqual([])
  })

  it('includes untracked files only when asked', async () => {
    seedRepo()
    writeFileSync(path.join(tmpDir, 'fresh.txt'), 'new\n')

    await dispatcher.callRequest('git.stashPush', {
      worktreePath: tmpDir,
      includeUntracked: true
    })

    expect(existsSync(path.join(tmpDir, 'fresh.txt'))).toBe(false)
    await dispatcher.callRequest('git.stashPop', { worktreePath: tmpDir })
    expect(existsSync(path.join(tmpDir, 'fresh.txt'))).toBe(true)
  })

  it('records a stash message', async () => {
    seedRepo()
    writeFileSync(path.join(tmpDir, 'tracked.txt'), 'edited\n')

    await dispatcher.callRequest('git.stashPush', {
      worktreePath: tmpDir,
      message: 'parked: relay work'
    })

    expect((await listEntries())[0].subject).toContain('parked: relay work')
  })

  it('keeps the entry when apply is requested and drops it on pop', async () => {
    seedRepo()
    writeFileSync(path.join(tmpDir, 'tracked.txt'), 'edited\n')
    await dispatcher.callRequest('git.stashPush', { worktreePath: tmpDir })

    expect(
      await dispatcher.callRequest('git.stashApply', {
        worktreePath: tmpDir,
        ref: 'stash@{0}'
      })
    ).toEqual({ success: true })
    expect(await listEntries()).toHaveLength(1)
  })

  it('drops and clears entries', async () => {
    seedRepo()
    for (const body of ['a', 'b']) {
      writeFileSync(path.join(tmpDir, 'tracked.txt'), `${body}\n`)
      await dispatcher.callRequest('git.stashPush', { worktreePath: tmpDir, message: body })
    }

    expect(
      await dispatcher.callRequest('git.stashDrop', {
        worktreePath: tmpDir,
        ref: 'stash@{0}'
      })
    ).toEqual({ ok: true })
    expect(await listEntries()).toHaveLength(1)

    expect(await dispatcher.callRequest('git.stashClear', { worktreePath: tmpDir })).toEqual({
      ok: true
    })
    expect(await listEntries()).toEqual([])
  })

  it('reports a pop conflict as conflicted and keeps the entry', async () => {
    seedRepo()
    writeFileSync(path.join(tmpDir, 'tracked.txt'), 'stashed side\n')
    await dispatcher.callRequest('git.stashPush', { worktreePath: tmpDir })
    writeFileSync(path.join(tmpDir, 'tracked.txt'), 'committed side\n')
    gitCommit(tmpDir, 'competing edit')

    const result = (await dispatcher.callRequest('git.stashPop', {
      worktreePath: tmpDir,
      ref: 'stash@{0}'
    })) as { success: boolean; conflicted?: boolean }

    expect(result.success).toBe(false)
    expect(result.conflicted).toBe(true)
    expect(await listEntries()).toHaveLength(1)
  })

  it('rejects a ref git would read as a flag', async () => {
    seedRepo()

    // Why: the relay is reachable independently of the RPC schema, so validation
    // has to happen here too.
    for (const ref of ['--all', '-p', 'HEAD', 'refs/stash']) {
      await expect(
        dispatcher.callRequest('git.stashDrop', { worktreePath: tmpDir, ref })
      ).rejects.toThrow('invalid_stash_ref')
    }
  })

  it('refuses a drop whose entry shifted after the client listed it', async () => {
    seedRepo()
    writeFileSync(path.join(tmpDir, 'tracked.txt'), 'target\n')
    await dispatcher.callRequest('git.stashPush', { worktreePath: tmpDir, message: 'target' })
    const picked = (await listEntries())[0]

    writeFileSync(path.join(tmpDir, 'tracked.txt'), 'other\n')
    await dispatcher.callRequest('git.stashPush', { worktreePath: tmpDir, message: 'other' })

    await expect(
      dispatcher.callRequest('git.stashDrop', {
        worktreePath: tmpDir,
        ref: picked.ref,
        expectedCommitOid: picked.commitOid
      })
    ).rejects.toThrow('stash_entry_moved')
    expect(await listEntries()).toHaveLength(2)
  })

  it('rejects a malformed ref instead of silently targeting the newest entry', async () => {
    // Why: coercing a present-but-non-string ref to "absent" would turn a bad
    // request into a pop of a different stash rather than a refusal.
    seedRepo()
    writeFileSync(path.join(tmpDir, 'tracked.txt'), 'first\n')
    await dispatcher.callRequest('git.stashPush', { worktreePath: tmpDir, message: 'first' })
    writeFileSync(path.join(tmpDir, 'tracked.txt'), 'second\n')
    await dispatcher.callRequest('git.stashPush', { worktreePath: tmpDir, message: 'second' })

    for (const ref of [42, {}, [], true]) {
      await expect(
        dispatcher.callRequest('git.stashPop', { worktreePath: tmpDir, ref })
      ).rejects.toThrow('invalid_stash_ref')
    }
    expect(await listEntries()).toHaveLength(2)
  })

  it('rejects a malformed oid instead of disabling the race guard', async () => {
    seedRepo()
    writeFileSync(path.join(tmpDir, 'tracked.txt'), 'edited\n')
    await dispatcher.callRequest('git.stashPush', { worktreePath: tmpDir })

    await expect(
      dispatcher.callRequest('git.stashDrop', {
        worktreePath: tmpDir,
        ref: 'stash@{0}',
        expectedCommitOid: 12345
      })
    ).rejects.toThrow('invalid_stash_oid')
    expect(await listEntries()).toHaveLength(1)
  })

  it('still treats an omitted ref as the newest entry', async () => {
    seedRepo()
    writeFileSync(path.join(tmpDir, 'tracked.txt'), 'edited\n')
    await dispatcher.callRequest('git.stashPush', { worktreePath: tmpDir })

    expect(await dispatcher.callRequest('git.stashPop', { worktreePath: tmpDir })).toEqual({
      success: true
    })
    expect(await listEntries()).toEqual([])
  })

  it('rejects a missing worktree path', async () => {
    await expect(dispatcher.callRequest('git.stashList', {})).rejects.toThrow(
      'invalid_worktree_path'
    )
  })

  it('leaves the working tree clean for a subsequent status read', async () => {
    seedRepo()
    writeFileSync(path.join(tmpDir, 'tracked.txt'), 'edited\n')
    await dispatcher.callRequest('git.stashPush', { worktreePath: tmpDir })

    // Why: the mutation clears the relay's read caches, so status must not join a
    // pre-stash read and report the file as still dirty.
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: tmpDir,
      encoding: 'utf-8'
    })
    expect(status.trim()).toBe('')
  })
})

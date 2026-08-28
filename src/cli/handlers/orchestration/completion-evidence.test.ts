import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '../../../shared/child-process/run-process'
import { observeCompletionEvidence } from './completion-evidence'

/** B6 — Orca observes the completion evidence itself, so these run against a
 *  real throwaway Git worktree rather than a mocked one. */
describe('observed completion evidence', () => {
  const created: string[] = []

  afterEach(() => {
    for (const dir of created.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  async function git(cwd: string, args: string[]): Promise<void> {
    const result = await runProcess({ program: 'git', args, cwd, timeoutMs: 30_000 })
    if (result.code !== 0) {
      throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
    }
  }

  async function repo(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'orca-completion-evidence-'))
    created.push(dir)
    await git(dir, ['init', '--initial-branch=main'])
    await git(dir, ['config', 'user.email', 'test@example.com'])
    await git(dir, ['config', 'user.name', 'Test'])
    await git(dir, ['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    await git(dir, ['add', '.'])
    await git(dir, ['commit', '-m', 'first'])
    return dir
  }

  it('reports the real HEAD and a clean tree', async () => {
    const dir = await repo()
    const observed = await observeCompletionEvidence(dir)
    expect(observed.placement).toBe('local')
    expect(observed.worktreeClean).toBe(true)
    expect(observed.unavailableReason).toBeNull()
    expect(observed.headSha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('reports a dirty tree when the worker left uncommitted changes', async () => {
    const dir = await repo()
    writeFileSync(join(dir, 'a.txt'), 'two\n')
    const observed = await observeCompletionEvidence(dir)
    expect(observed.worktreeClean).toBe(false)
    expect(observed.headSha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('reports a folder workspace as an explicit placement, not a fabricated SHA', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-completion-evidence-folder-'))
    created.push(dir)
    const observed = await observeCompletionEvidence(dir)
    expect(observed).toMatchObject({ placement: 'folder', headSha: null, worktreeClean: false })
    expect(observed.unavailableReason).toBeTruthy()
  })
})

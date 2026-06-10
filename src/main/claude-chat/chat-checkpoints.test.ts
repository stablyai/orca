import { describe, it, expect, vi } from 'vitest'
import { ChatCheckpoints } from './chat-checkpoints'
import type { GitRunner } from './chat-checkpoints'

function makeRunner(responses: { stdout: string; exitCode: number }[]): {
  runner: GitRunner
  calls: { args: string[]; env?: Record<string, string> }[]
} {
  const calls: { args: string[]; env?: Record<string, string> }[] = []
  let idx = 0
  const runner: GitRunner = vi.fn(async (args, opts) => {
    calls.push({ args, env: opts.env })
    const response = responses[idx] ?? { stdout: '', exitCode: 0 }
    idx++
    return response
  })
  return { runner, calls }
}

describe('ChatCheckpoints.snapshot', () => {
  it('issues add -A / write-tree / commit-tree / update-ref in order with GIT_INDEX_FILE env', async () => {
    const { runner, calls } = makeRunner([
      { stdout: '', exitCode: 0 }, // add -A
      { stdout: 'deadbeef1234567890deadbeef1234567890dead\n', exitCode: 0 }, // write-tree
      { stdout: 'abcdef1234', exitCode: 0 }, // rev-parse HEAD
      { stdout: 'cafe5678cafe5678cafe5678cafe5678cafe5678\n', exitCode: 0 }, // commit-tree
      { stdout: '', exitCode: 0 } // update-ref
    ])
    const cp = new ChatCheckpoints(runner)
    const result = await cp.snapshot('/repo', 'test label')

    expect(result).not.toBeNull()
    expect(result?.sha).toBe('cafe5678cafe5678cafe5678cafe5678cafe5678')
    expect(result?.label).toBe('test label')
    expect(result?.createdAt).toBeTruthy()

    // add -A uses env with GIT_INDEX_FILE
    expect(calls[0].args).toEqual(['add', '-A'])
    expect(calls[0].env?.GIT_INDEX_FILE).toBeTruthy()

    // write-tree uses same GIT_INDEX_FILE
    expect(calls[1].args).toEqual(['write-tree'])
    expect(calls[1].env?.GIT_INDEX_FILE).toBeTruthy()
    expect(calls[1].env?.GIT_INDEX_FILE).toBe(calls[0].env?.GIT_INDEX_FILE)

    // commit-tree includes -p <headSha>
    expect(calls[3].args[0]).toBe('commit-tree')
    expect(calls[3].args).toContain('-p')

    // update-ref sets refs/orca-chat/<prefix>
    expect(calls[4].args[0]).toBe('update-ref')
    expect(calls[4].args[1]).toMatch(/^refs\/orca-chat\//)
  })

  it('returns null when write-tree fails', async () => {
    const { runner } = makeRunner([
      { stdout: '', exitCode: 0 }, // add -A
      { stdout: '', exitCode: 128 } // write-tree fails
    ])
    const cp = new ChatCheckpoints(runner)
    const result = await cp.snapshot('/repo', 'fail')
    expect(result).toBeNull()
  })

  it('returns null when add -A fails', async () => {
    const { runner } = makeRunner([{ stdout: '', exitCode: 128 }])
    const cp = new ChatCheckpoints(runner)
    const result = await cp.snapshot('/repo', 'fail')
    expect(result).toBeNull()
  })

  it('still succeeds when HEAD does not exist (new repo, no commits)', async () => {
    const { runner, calls } = makeRunner([
      { stdout: '', exitCode: 0 }, // add -A
      { stdout: 'tree1234\n', exitCode: 0 }, // write-tree
      { stdout: '', exitCode: 128 }, // rev-parse HEAD fails (no commits)
      { stdout: 'commitabc\n', exitCode: 0 }, // commit-tree without -p
      { stdout: '', exitCode: 0 } // update-ref
    ])
    const cp = new ChatCheckpoints(runner)
    const result = await cp.snapshot('/repo', 'new repo')
    expect(result).not.toBeNull()
    // commit-tree should not have -p
    expect(calls[3].args).not.toContain('-p')
  })
})

describe('ChatCheckpoints.revert', () => {
  it('builds the correct restore command and returns true on exitCode 0', async () => {
    const { runner, calls } = makeRunner([{ stdout: '', exitCode: 0 }])
    const cp = new ChatCheckpoints(runner)
    const ok = await cp.revert('/repo', 'abc123')
    expect(ok).toBe(true)
    expect(calls[0].args).toEqual(['restore', '--worktree', '--source=abc123', '--', '.'])
  })

  it('returns false when restore exits non-zero', async () => {
    const { runner } = makeRunner([{ stdout: '', exitCode: 1 }])
    const cp = new ChatCheckpoints(runner)
    const ok = await cp.revert('/repo', 'abc123')
    expect(ok).toBe(false)
  })
})

describe('ChatCheckpoints.changedFiles', () => {
  it('parses M/A/D lines', async () => {
    const diffOutput = ['M\tsrc/foo.ts', 'A\tsrc/new.ts', 'D\tsrc/old.ts'].join('\n')
    const { runner } = makeRunner([{ stdout: diffOutput, exitCode: 0 }])
    const cp = new ChatCheckpoints(runner)
    const files = await cp.changedFiles('/repo', 'abc123')
    expect(files).toEqual([
      { status: 'M', path: 'src/foo.ts' },
      { status: 'A', path: 'src/new.ts' },
      { status: 'D', path: 'src/old.ts' }
    ])
  })

  it('parses R (rename) lines and uses the new path with status R', async () => {
    const diffOutput = 'R100\told/path.ts\tnew/path.ts'
    const { runner } = makeRunner([{ stdout: diffOutput, exitCode: 0 }])
    const cp = new ChatCheckpoints(runner)
    const files = await cp.changedFiles('/repo', 'abc123')
    expect(files).toEqual([{ status: 'R', path: 'new/path.ts' }])
  })

  it('returns empty array when diff fails', async () => {
    const { runner } = makeRunner([{ stdout: '', exitCode: 128 }])
    const cp = new ChatCheckpoints(runner)
    const files = await cp.changedFiles('/repo', 'abc123')
    expect(files).toEqual([])
  })

  it('passes the sha as the diff argument', async () => {
    const { runner, calls } = makeRunner([{ stdout: '', exitCode: 0 }])
    const cp = new ChatCheckpoints(runner)
    await cp.changedFiles('/repo', 'mysha')
    expect(calls[0].args).toEqual(['diff', '--name-status', 'mysha'])
  })
})

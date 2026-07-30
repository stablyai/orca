import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))
vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileAsyncBuffer: vi.fn(),
  translateWslOutputPaths: (output: string) => output
}))
vi.mock('./status', () => ({
  runWithGitReadCacheInvalidation: <T>(run: () => Promise<T>) => run()
}))

import {
  applyStash,
  assertValidStashRef,
  clearStashes,
  dropStash,
  listStashes,
  popStash,
  stashChanges
} from './stash'

const OID = 'b6ca323068fc18c2133f1cc3eb3c2a95e127de7d'

function execError(fields: { stderr?: string; stdout?: string; message?: string }): Error {
  return Object.assign(new Error(fields.message ?? 'git failed'), {
    stderr: fields.stderr ?? '',
    stdout: fields.stdout ?? ''
  })
}

function gitCalls(): string[][] {
  return gitExecFileAsyncMock.mock.calls.map((call) => call[0] as string[])
}

beforeEach(() => {
  gitExecFileAsyncMock.mockReset()
  gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
})

describe('assertValidStashRef', () => {
  it.each(['stash@{0}', 'stash@{12}'])('accepts %s', (ref) => {
    expect(() => assertValidStashRef(ref)).not.toThrow()
  })

  it.each(['--all', '-p', 'HEAD', 'refs/stash', 'stash@{}', 'stash@{-1}', '', 'stash@{0} extra'])(
    'rejects %j',
    (ref) => {
      expect(() => assertValidStashRef(ref)).toThrow('invalid_stash_ref')
    }
  )
})

describe('listStashes', () => {
  it('requests the NUL-delimited format and parses entries', async () => {
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: `stash@{0}\x00${OID}\x001785416506\x00WIP on main: init\x00`,
      stderr: ''
    })

    const entries = await listStashes('/repo')

    expect(gitCalls()).toEqual([['stash', 'list', '-z', '--format=%gd%x00%H%x00%ct%x00%gs']])
    expect(gitExecFileAsyncMock.mock.calls[0][1]).toEqual({ cwd: '/repo' })
    expect(entries).toEqual([
      {
        ref: 'stash@{0}',
        index: 0,
        commitOid: OID,
        createdAtSeconds: 1785416506,
        subject: 'WIP on main: init'
      }
    ])
  })

  it('forwards the WSL distro so native and WSL hosts stay separate', async () => {
    await listStashes('/repo', { wslDistro: 'Ubuntu' })
    expect(gitExecFileAsyncMock.mock.calls[0][1]).toEqual({ cwd: '/repo', wslDistro: 'Ubuntu' })
  })
})

describe('stashChanges', () => {
  it('stashes tracked changes only by default', async () => {
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'Saved working directory and index state WIP on main: abc init\n',
      stderr: ''
    })

    const result = await stashChanges('/repo')

    expect(gitCalls()).toEqual([['stash', 'push', '--']])
    expect(result).toEqual({ success: true, stashed: true })
  })

  it('adds --include-untracked when asked', async () => {
    await stashChanges('/repo', { includeUntracked: true })
    expect(gitCalls()).toEqual([['stash', 'push', '--include-untracked', '--']])
  })

  it('passes a message through -m before the argument terminator', async () => {
    await stashChanges('/repo', { message: 'parked work' })
    expect(gitCalls()).toEqual([['stash', 'push', '-m', 'parked work', '--']])
  })

  it('reports stashed:false when git found nothing to save', async () => {
    // Why: git exits 0 here, so only the message distinguishes it from a real stash.
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'No local changes to save\n', stderr: '' })

    expect(await stashChanges('/repo')).toEqual({ success: true, stashed: false })
  })

  it('surfaces a stash failure from stderr', async () => {
    gitExecFileAsyncMock.mockRejectedValue(execError({ stderr: 'error: cannot stash\n' }))

    expect(await stashChanges('/repo')).toEqual({
      success: false,
      stashed: false,
      error: 'error: cannot stash'
    })
  })

  it.each([
    ['', 'empty'],
    ['x'.repeat(501), 'over the length cap']
  ])('rejects a %s message', async (message) => {
    await expect(stashChanges('/repo', { message })).rejects.toThrow('invalid_stash_message')
    expect(gitCalls()).toEqual([])
  })
})

describe('applyStash / popStash', () => {
  it.each([
    ['apply', applyStash],
    ['pop', popStash]
  ])('targets the latest entry when no ref is given (%s)', async (subcommand, run) => {
    expect(await run('/repo', null)).toEqual({ success: true })
    expect(gitCalls()).toEqual([['stash', subcommand]])
  })

  it.each([
    ['apply', applyStash],
    ['pop', popStash]
  ])('passes an explicit ref after -- (%s)', async (subcommand, run) => {
    await run('/repo', 'stash@{1}')
    expect(gitCalls()).toEqual([['stash', subcommand, '--', 'stash@{1}']])
  })

  it.each([applyStash, popStash])('rejects a ref git would read as a flag', async (run) => {
    await expect(run('/repo', '--all')).rejects.toThrow('invalid_stash_ref')
    expect(gitCalls()).toEqual([])
  })

  it('reports a conflict as conflicted rather than a plain failure', async () => {
    gitExecFileAsyncMock.mockRejectedValue(
      execError({
        stdout: 'Auto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt\n',
        stderr: 'The stash entry is kept in case you need it again.\n'
      })
    )

    const result = await popStash('/repo', null)

    expect(result.success).toBe(false)
    expect(result.conflicted).toBe(true)
    expect(result.error).toContain('The stash entry is kept')
  })

  it('treats an untracked-file collision as a conflict', async () => {
    gitExecFileAsyncMock.mockRejectedValue(
      execError({ stderr: 'could not restore untracked files from stash\n' })
    )

    expect((await popStash('/repo', null)).conflicted).toBe(true)
  })

  it('leaves a non-conflict failure unflagged', async () => {
    gitExecFileAsyncMock.mockRejectedValue(execError({ stderr: 'fatal: not a git repository\n' }))

    const result = await applyStash('/repo', null)

    expect(result).toEqual({ success: false, error: 'fatal: not a git repository' })
    expect(result.conflicted).toBeUndefined()
  })

  it('falls back to the Error message when git wrote nothing', async () => {
    gitExecFileAsyncMock.mockRejectedValue(new Error('spawn ENOENT'))
    expect((await applyStash('/repo', null)).error).toBe('spawn ENOENT')
  })

  it('verifies the picked entry before applying it', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) =>
      args[0] === 'rev-parse' ? { stdout: `${OID}\n`, stderr: '' } : { stdout: '', stderr: '' }
    )

    await popStash('/repo', 'stash@{1}', OID)

    expect(gitCalls()).toEqual([
      ['rev-parse', '--verify', '--quiet', 'stash@{1}^{commit}'],
      ['stash', 'pop', '--', 'stash@{1}']
    ])
  })

  it('refuses to pop when the entry shifted under the picker', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) =>
      args[0] === 'rev-parse'
        ? { stdout: 'ffffffffffffffffffffffffffffffffffffffff\n', stderr: '' }
        : { stdout: '', stderr: '' }
    )

    await expect(popStash('/repo', 'stash@{1}', OID)).rejects.toThrow('stash_entry_moved')
    // Why: the destructive command must never run once identity is in doubt.
    expect(gitCalls()).toEqual([['rev-parse', '--verify', '--quiet', 'stash@{1}^{commit}']])
  })

  it('treats a vanished entry (rev-parse fatal) as a shift', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rev-parse') {
        throw execError({ stderr: 'fatal: needed a single revision\n' })
      }
      return { stdout: '', stderr: '' }
    })

    await expect(popStash('/repo', 'stash@{9}', OID)).rejects.toThrow('stash_entry_moved')
  })

  it('skips the identity probe when the caller has no expected oid', async () => {
    await popStash('/repo', 'stash@{0}')
    expect(gitCalls()).toEqual([['stash', 'pop', '--', 'stash@{0}']])
  })

  it('verifies the newest entry when an oid is given without a ref', async () => {
    // Why: "pop the latest, but only if it is still the one I saw" must not
    // silently skip the guard just because the ref was left implicit.
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) =>
      args[0] === 'rev-parse' ? { stdout: `${OID}\n`, stderr: '' } : { stdout: '', stderr: '' }
    )

    await popStash('/repo', null, OID)

    expect(gitCalls()).toEqual([
      ['rev-parse', '--verify', '--quiet', 'stash@{0}^{commit}'],
      ['stash', 'pop']
    ])
  })

  it('refuses an implicit-latest pop when the newest entry changed', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) =>
      args[0] === 'rev-parse'
        ? { stdout: 'ffffffffffffffffffffffffffffffffffffffff\n', stderr: '' }
        : { stdout: '', stderr: '' }
    )

    await expect(popStash('/repo', null, OID)).rejects.toThrow('stash_entry_moved')
    expect(gitCalls()).toEqual([['rev-parse', '--verify', '--quiet', 'stash@{0}^{commit}']])
  })
})

describe('dropStash / clearStashes', () => {
  it('drops one entry after -- ', async () => {
    await dropStash('/repo', 'stash@{2}')
    expect(gitCalls()).toEqual([['stash', 'drop', '--', 'stash@{2}']])
  })

  it('verifies identity before dropping', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) =>
      args[0] === 'rev-parse' ? { stdout: `${OID}\n`, stderr: '' } : { stdout: '', stderr: '' }
    )

    await dropStash('/repo', 'stash@{0}', OID)

    expect(gitCalls()).toEqual([
      ['rev-parse', '--verify', '--quiet', 'stash@{0}^{commit}'],
      ['stash', 'drop', '--', 'stash@{0}']
    ])
  })

  it('rejects an invalid drop ref before running git', async () => {
    await expect(dropStash('/repo', 'HEAD')).rejects.toThrow('invalid_stash_ref')
    expect(gitCalls()).toEqual([])
  })

  it('propagates a drop failure', async () => {
    gitExecFileAsyncMock.mockRejectedValue(execError({ stderr: 'fatal: log is empty\n' }))
    await expect(dropStash('/repo', 'stash@{0}')).rejects.toThrow()
  })

  it('clears every entry', async () => {
    await clearStashes('/repo')
    expect(gitCalls()).toEqual([['stash', 'clear']])
  })
})

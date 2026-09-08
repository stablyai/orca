// src/relay/ssh-outbound-git-provider.test.ts
// TASK-AG-EVM-007: gitStatusViaHiddenTarget — `git status --porcelain=v1 -b`
// run via ssh2's exec() over a hidden target's dialed OutboundSshSession.
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { OutboundSshSession } from './ssh-outbound-client'

class FakeChannel extends EventEmitter {
  stderr = new EventEmitter()
}

function makeFakeSession(exec: ReturnType<typeof vi.fn>): OutboundSshSession {
  return {
    client: { exec } as unknown as OutboundSshSession['client'],
    close: vi.fn()
  }
}

function respondWith(channel: FakeChannel, stdout: string, stderr: string, exitCode: number): void {
  queueMicrotask(() => {
    if (stdout) {
      channel.emit('data', Buffer.from(stdout))
    }
    if (stderr) {
      channel.stderr.emit('data', Buffer.from(stderr))
    }
    channel.emit('exit', exitCode)
    channel.emit('close')
  })
}

beforeEach(async () => {
  const { hiddenTargetRegistry } = await import('./agent-ephemeral-vm-handler')
  hiddenTargetRegistry.clear()
})

describe('validateGitStatusViaHiddenTargetParams', () => {
  it('returns validated params', async () => {
    const { validateGitStatusViaHiddenTargetParams } = await import('./ssh-outbound-git-provider')
    expect(
      validateGitStatusViaHiddenTargetParams({ hiddenTargetId: 'rt-1', repoPath: '/srv/app' })
    ).toEqual({ hiddenTargetId: 'rt-1', repoPath: '/srv/app' })
  })

  it('throws when repoPath is missing', async () => {
    const { validateGitStatusViaHiddenTargetParams } = await import('./ssh-outbound-git-provider')
    expect(() => validateGitStatusViaHiddenTargetParams({ hiddenTargetId: 'rt-1' })).toThrow(
      /repoPath/
    )
  })
})

describe('gitStatusViaHiddenTarget', () => {
  it('runs `git -C <repoPath> status --porcelain=v1 -b` on the hidden target session and parses output', async () => {
    const channel = new FakeChannel()
    const exec = vi.fn((_cmd: string, cb: (err: undefined, channel: FakeChannel) => void) => {
      cb(undefined, channel)
    })
    const session = makeFakeSession(exec)
    const { hiddenTargetRegistry } = await import('./agent-ephemeral-vm-handler')
    hiddenTargetRegistry.set('rt-1', session)

    const { gitStatusViaHiddenTarget } = await import('./ssh-outbound-git-provider')
    const pending = gitStatusViaHiddenTarget({ hiddenTargetId: 'rt-1', repoPath: '/srv/app' })
    respondWith(
      channel,
      '## main...origin/main [ahead 2, behind 1]\n M src/index.ts\n?? new-file.txt\n',
      '',
      0
    )
    const result = await pending

    expect(exec).toHaveBeenCalledWith(
      "git -C '/srv/app' status --porcelain=v1 -b",
      expect.any(Function)
    )
    expect(result).toEqual({
      branch: 'main',
      ahead: 2,
      behind: 1,
      files: [
        { path: 'src/index.ts', indexStatus: ' ', worktreeStatus: 'M' },
        { path: 'new-file.txt', indexStatus: '?', worktreeStatus: '?' }
      ]
    })
  })

  it('single-quotes repoPath, escaping any embedded single quote (no shell injection)', async () => {
    const channel = new FakeChannel()
    const exec = vi.fn((_cmd: string, cb: (err: undefined, channel: FakeChannel) => void) => {
      cb(undefined, channel)
    })
    const session = makeFakeSession(exec)
    const { hiddenTargetRegistry } = await import('./agent-ephemeral-vm-handler')
    hiddenTargetRegistry.set('rt-quote', session)

    const { gitStatusViaHiddenTarget } = await import('./ssh-outbound-git-provider')
    const pending = gitStatusViaHiddenTarget({
      hiddenTargetId: 'rt-quote',
      repoPath: "/srv/app'; rm -rf /"
    })
    respondWith(channel, '## main\n', '', 0)
    await pending

    expect(exec).toHaveBeenCalledWith(
      "git -C '/srv/app'\\''; rm -rf /' status --porcelain=v1 -b",
      expect.any(Function)
    )
  })

  it('throws a clear error, does not hang, when hiddenTargetId is not registered', async () => {
    const { gitStatusViaHiddenTarget } = await import('./ssh-outbound-git-provider')
    await expect(
      gitStatusViaHiddenTarget({ hiddenTargetId: 'no-such-target', repoPath: '/srv/app' })
    ).rejects.toThrow(/No hidden target session/)
  })

  it('throws with a clear message when git exits non-zero', async () => {
    const channel = new FakeChannel()
    const exec = vi.fn((_cmd: string, cb: (err: undefined, channel: FakeChannel) => void) => {
      cb(undefined, channel)
    })
    const session = makeFakeSession(exec)
    const { hiddenTargetRegistry } = await import('./agent-ephemeral-vm-handler')
    hiddenTargetRegistry.set('rt-bad-repo', session)

    const { gitStatusViaHiddenTarget } = await import('./ssh-outbound-git-provider')
    const pending = gitStatusViaHiddenTarget({
      hiddenTargetId: 'rt-bad-repo',
      repoPath: '/no/repo'
    })
    respondWith(channel, '', 'fatal: not a git repository\n', 128)

    await expect(pending).rejects.toThrow(/exited 128/)
    await expect(pending.catch((e: Error) => e.message)).resolves.toContain('not a git repository')
  })
})

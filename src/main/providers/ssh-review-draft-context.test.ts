import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { ReviewDraftContextError } from '../../shared/review-draft-context-error'
import { RelayContext } from '../../relay/context'
import { RelayDispatcher } from '../../relay/dispatcher'
import { GitHandler } from '../../relay/git-handler'
import { createGitTempDir, removeGitTempDir } from '../../relay/git-handler-test-harness'
import { gitCommit, gitInit } from '../../relay/git-handler-test-setup'
import {
  encodeJsonRpcFrame,
  FrameDecoder,
  MessageType,
  parseJsonRpcMessage
} from '../../relay/protocol'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { getPullRequestDraftContext } from '../text-generation/pull-request-context'
import { SshGitProvider } from './ssh-git-provider'
import { createMockMux } from './ssh-git-provider-test-harness'
import { execSshReviewDraft } from './ssh-review-draft-context'

const input = {
  base: 'main',
  currentTitle: 'Existing review title',
  currentBody: 'Existing review body',
  currentDraft: true
}
const mergeBase = 'a'.repeat(40)
const disposals: (() => void)[] = []
const directories: string[] = []

afterEach(async () => {
  disposals.splice(0).forEach((dispose) => dispose())
  await Promise.all(directories.splice(0).map(removeGitTempDir))
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function providerForMux(mux: ReturnType<typeof createMockMux>): SshGitProvider {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this harness implements every request, stream notification, disposal and notify method used by these provider calls.
  return new SshGitProvider('review-host', mux as unknown as SshChannelMultiplexer)
}

function createWireProvider() {
  const mux = createMockMux()
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  const notifications = new Map<string, Set<(params: Record<string, unknown>) => void>>()
  const decoder = new FrameDecoder((frame) => {
    if (frame.type !== MessageType.Regular) {
      return
    }
    const message = parseJsonRpcMessage(frame.payload)
    if ('method' in message) {
      notifications.get(message.method)?.forEach((listener) => listener(message.params ?? {}))
      return
    }
    const request = pending.get(message.id)
    if (!request) {
      return
    }
    pending.delete(message.id)
    if (message.error) {
      request.reject(Object.assign(new Error(message.error.message), { code: message.error.code }))
    } else {
      request.resolve(message.result)
    }
  })
  const dispatcher = new RelayDispatcher((frame) => decoder.feed(frame))
  const handler = new GitHandler(dispatcher, new RelayContext())
  let sequence = 0
  mux.request.mockImplementation((method: string, params: Record<string, unknown>) => {
    const id = ++sequence
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      dispatcher.feed(encodeJsonRpcFrame({ jsonrpc: '2.0', id, method, params }, id, 0))
    })
  })
  mux.notify.mockImplementation((method: string, params: Record<string, unknown>) => {
    dispatcher.feed(encodeJsonRpcFrame({ jsonrpc: '2.0', method, params }, ++sequence, 0))
  })
  mux.onNotificationByMethod.mockImplementation(
    (method: string, listener: (params: Record<string, unknown>) => void) => {
      const listeners = notifications.get(method) ?? new Set()
      notifications.set(method, listeners)
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  )
  disposals.push(() => {
    handler.dispose()
    dispatcher.dispose()
    pending.forEach((request) => request.reject(new Error('Test relay disposed')))
    pending.clear()
  })
  return { provider: providerForMux(mux), mux, dispatcher, notifications }
}

async function git(cwd: string, args: string[]) {
  const result = await runProcess({ program: 'git', args, cwd, timeoutMs: 10_000 })
  if (result.code !== 0) {
    throw Object.assign(new Error(result.stderr), { code: result.code })
  }
  return { stdout: result.stdout, stderr: result.stderr }
}

async function createReviewFixture(large: boolean) {
  const root = createGitTempDir()
  directories.push(root)
  const globalConfig = join(root, 'global.gitconfig')
  await writeFile(globalConfig, '')
  // Newer desktop Git preferences may be rejected while a baseline fixture loads config.
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  const remote = join(root, 'remote repo')
  const worktree = join(root, 'review worktree')
  await mkdir(remote)
  gitInit(remote)
  await git(remote, ['checkout', '-b', 'main'])
  await writeFile(join(remote, 'README.md'), 'Original content\n')
  gitCommit(remote, 'Initial base')
  await git(root, ['clone', remote, worktree])
  const originalBase = (await git(worktree, ['rev-parse', 'HEAD'])).stdout.trim()
  await writeFile(join(remote, 'base-only.txt'), 'Advance the remote base after cloning\n')
  gitCommit(remote, 'Advance base')
  await git(worktree, ['checkout', '-b', 'feature/review'])
  await writeFile(join(worktree, 'README.md'), 'Committed review evidence\n')
  await writeFile(
    join(worktree, 'new file.txt'),
    large
      ? 'Committed line with unicode café for a streamed review.\n'.repeat(36_000)
      : 'New evidence\n'
  )
  gitCommit(worktree, 'Add review evidence')
  await writeFile(join(worktree, 'README.md'), 'Uncommitted content must stay out of the draft\n')
  return { worktree, originalBase }
}

describe('SSH review draft through the real relay dispatcher', () => {
  it.each([false, true])('matches complete local context with streamed patch=%s', async (large) => {
    const { worktree, originalBase } = await createReviewFixture(large)
    const local = await getPullRequestDraftContext((args) => git(worktree, args), input)
    expect(local).toMatchObject({
      branch: 'feature/review',
      commitSummary: '- Add review evidence',
      changeSummary: expect.stringContaining('new file.txt'),
      patch: expect.stringContaining('+Committed review evidence')
    })
    await git(worktree, ['update-ref', 'refs/remotes/origin/main', originalBase])
    const { provider, mux, notifications } = createWireProvider()

    const remote = await getPullRequestDraftContext(
      (args, options) => execSshReviewDraft(provider, args, worktree, options),
      input
    )

    expect(remote).toEqual(local)
    expect(remote?.patch).not.toContain('Uncommitted content')
    expect(mux.request).toHaveBeenCalledWith('git.fetchRemoteTrackingRef', {
      worktreePath: worktree,
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main'
    })
    expect(mux.request.mock.calls.filter(([method]) => method === 'git.reviewDiff')).toHaveLength(2)
    expect(
      mux.request.mock.calls.some(
        ([method, params]) =>
          method === 'git.exec' && (params.args[0] === 'fetch' || params.args[0] === 'diff')
      )
    ).toBe(false)
    expect([...notifications.values()].every((listeners) => listeners.size === 0)).toBe(true)
    if (large) {
      expect(mux.notify).toHaveBeenCalledWith('git.responseAck', expect.any(Object))
    }
  })
})

function createContextProvider() {
  const mux = createMockMux()
  const runRequest = async (method: string, params: Record<string, unknown>) => {
    if (method === 'git.fetchRemoteTrackingRef') {
      return undefined
    }
    if (method === 'git.reviewDiff') {
      return { stdout: 'remote evidence', stderr: '' }
    }
    const args = params.args
    if (!Array.isArray(args)) {
      throw new Error('Missing context Git arguments')
    }
    if (args[0] === 'remote') {
      return { stdout: 'origin\n', stderr: '' }
    }
    if (args[0] === 'show-ref') {
      return { stdout: '', stderr: '' }
    }
    if (args[0] === 'branch') {
      return { stdout: 'feature/review\n', stderr: '' }
    }
    if (args[0] === 'merge-base') {
      return { stdout: `${mergeBase}\n`, stderr: '' }
    }
    if (args[0] === 'log') {
      return { stdout: '- committed evidence\n', stderr: '' }
    }
    throw new Error(`Unexpected method ${method}`)
  }
  mux.request.mockImplementation(runRequest)
  return { mux, provider: providerForMux(mux), runRequest }
}

describe('SSH review draft failures and routing', () => {
  it('rejects an old-host missing diff method instead of returning commit-only context', async () => {
    const { mux, provider, runRequest } = createContextProvider()
    mux.request.mockImplementation((method, params) => {
      if (method === 'git.reviewDiff') {
        return Promise.reject(Object.assign(new Error('Method not found'), { code: -32601 }))
      }
      return runRequest(method, params)
    })

    await expect(
      getPullRequestDraftContext(
        (args, options) => execSshReviewDraft(provider, args, '/repo', options),
        input
      )
    ).rejects.toThrow('Reconnect the SSH target')
  })

  it.each(['SSH connection closed', 'Git request timed out', 'git output exceeded maxBuffer.'])(
    'rejects incomplete context after %s',
    async (message) => {
      const { mux, provider, runRequest } = createContextProvider()
      mux.request.mockImplementation((method, params) => {
        if (method === 'git.reviewDiff') {
          return Promise.reject(new Error(message))
        }
        return runRequest(method, params)
      })
      const draft = getPullRequestDraftContext(
        (args, options) => execSshReviewDraft(provider, args, '/repo', options),
        input
      )
      await expect(draft).rejects.toBeInstanceOf(ReviewDraftContextError)
      await expect(draft).rejects.toThrow(message)
    }
  )

  it('stops before reading evidence when an old host lacks the narrow fetch method', async () => {
    const { mux, provider, runRequest } = createContextProvider()
    mux.request.mockImplementation((method, params) => {
      if (method === 'git.fetchRemoteTrackingRef') {
        return Promise.reject(
          Object.assign(new Error('Method not found: git.fetchRemoteTrackingRef'), { code: -32601 })
        )
      }
      return runRequest(method, params)
    })
    await expect(
      getPullRequestDraftContext(
        (args, options) => execSshReviewDraft(provider, args, '/repo', options),
        input
      )
    ).rejects.toThrow('Fetch before generating PR details failed')
    expect(mux.request.mock.calls.some(([method]) => method === 'git.reviewDiff')).toBe(false)
  })

  it.each([
    undefined,
    null,
    {},
    { stdout: 'patch' },
    { stdout: 3, stderr: '' },
    { stdout: '', stderr: null }
  ])('refuses malformed remote evidence %j', async (reply) => {
    const mux = createMockMux()
    mux.request.mockResolvedValue(reply)
    await expect(providerForMux(mux).readReviewDiff('/repo', mergeBase, 'patch')).rejects.toThrow(
      ReviewDraftContextError
    )
  })

  it.each([{ timeout: 321 }, { timeoutMs: 654 }, { timeout: 321, timeoutMs: 654 }])(
    'forwards draft deadlines %j to the narrow diff request',
    async (options) => {
      const mux = createMockMux()
      mux.request.mockResolvedValue({ stdout: 'patch', stderr: '' })
      await execSshReviewDraft(
        providerForMux(mux),
        ['diff', '--name-status', `${mergeBase}..HEAD`],
        '/repo',
        options
      )
      expect(mux.request).toHaveBeenCalledWith(
        'git.reviewDiff',
        {
          worktreePath: '/repo',
          mergeBase,
          format: 'name-status',
          __streamResponse: true
        },
        { signal: undefined, timeoutMs: options.timeoutMs ?? options.timeout }
      )
    }
  )

  it('keeps non-draft fetch and diff shapes on the restricted generic path', async () => {
    const mux = createMockMux()
    mux.request.mockResolvedValue({ stdout: '', stderr: '' })
    const provider = providerForMux(mux)
    for (const args of [
      ['fetch', '--all'],
      ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/heads/overwrite'],
      ['diff', '--name-status', '--no-ext-diff', `${mergeBase}..HEAD`],
      ['diff', '--patch', '--minimal', '--no-color', '--no-ext-diff', `${mergeBase}...HEAD`]
    ]) {
      await execSshReviewDraft(provider, args, '/repo', { timeoutMs: 456 })
      expect(mux.request).toHaveBeenLastCalledWith(
        'git.exec',
        {
          args,
          cwd: '/repo',
          __streamResponse: true
        },
        { signal: undefined, timeoutMs: 456 }
      )
    }
    expect(mux.request.mock.calls.every(([method]) => method === 'git.exec')).toBe(true)
  })
})

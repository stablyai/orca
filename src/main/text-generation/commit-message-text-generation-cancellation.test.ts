import { spawn } from 'node:child_process'
import type * as ChildProcess from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelGenerateCommitMessageLocal,
  cancelGeneratePullRequestFieldsLocal,
  discoverCommitMessageModelsLocal,
  generateCommitMessageFromContext,
  generatePullRequestFieldsFromContext
} from './commit-message-text-generation'
import {
  createChildTerminationExpectation,
  createMockDiscoveryChild
} from './commit-message-text-generation-test-harness'

const { terminateWindowsProcessTreeMock } = vi.hoisted(() => ({
  terminateWindowsProcessTreeMock: vi.fn(async () => {})
}))

vi.mock('../windows-process-tree-kill', () => ({
  terminateWindowsProcessTree: terminateWindowsProcessTreeMock
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>()
  return {
    ...actual,
    spawn: vi.fn(actual.spawn)
  }
})

const spawnMock = vi.mocked(spawn)

const expectChildTerminated = createChildTerminationExpectation(terminateWindowsProcessTreeMock)

beforeEach(() => {
  terminateWindowsProcessTreeMock.mockClear()
  terminateWindowsProcessTreeMock.mockResolvedValue(undefined)
  spawnMock.mockClear()
})

describe('generateCommitMessageFromContext', () => {
  it('keeps local commit-message and pull-request cancellation lanes separate', async () => {
    const children: {
      pid: number
      kill: ReturnType<typeof vi.fn>
      listeners: Map<string, (value: unknown) => void>
    }[] = []
    spawnMock.mockImplementation(() => {
      const listeners = new Map<string, (value: unknown) => void>()
      const child = {
        pid: 123 + children.length,
        kill: vi.fn(),
        stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
        stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
        stdin: { end: vi.fn() },
        on: vi.fn((event, callback) => listeners.set(event, callback))
      }
      children.push({ pid: child.pid, kill: child.kill, listeners })
      return child as never
    })

    const commit = generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'local',
        cwd: '/repo'
      }
    )
    const pullRequest = generatePullRequestFieldsFromContext(
      {
        branch: 'feature/pr-fields',
        base: 'main',
        branchChangedByPreparation: false,
        currentTitle: '',
        currentBody: '',
        currentDraft: false,
        commitSummary: '- feat: update README',
        changeSummary: 'M\tREADME.md',
        patch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'local',
        cwd: '/repo'
      }
    )

    cancelGenerateCommitMessageLocal('/repo')

    expectChildTerminated(children[0]!)
    expect(children[1]?.kill).not.toHaveBeenCalled()

    children[0]?.listeners.get('close')?.(null)
    const pullRequestStdout = children[1]?.listeners.get('stdout:data')
    pullRequestStdout?.(
      Buffer.from('{"base":"main","title":"Update README","body":"Details","draft":false}')
    )
    children[1]?.listeners.get('close')?.(0)

    await expect(commit).resolves.toEqual({
      success: false,
      error: 'Generation canceled.',
      canceled: true
    })
    await expect(pullRequest).resolves.toMatchObject({
      success: true,
      fields: {
        base: 'main',
        title: 'Update README',
        body: 'Details',
        draft: false
      }
    })

    cancelGeneratePullRequestFieldsLocal('/repo')
    expect(children[1]?.kill).not.toHaveBeenCalled()
  })

  it('keeps local pull-request cancellation from stopping commit-message generation', async () => {
    const children: {
      pid: number
      kill: ReturnType<typeof vi.fn>
      listeners: Map<string, (value: unknown) => void>
    }[] = []
    spawnMock.mockImplementation(() => {
      const listeners = new Map<string, (value: unknown) => void>()
      const child = {
        pid: 123 + children.length,
        kill: vi.fn(),
        stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
        stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
        stdin: { end: vi.fn() },
        on: vi.fn((event, callback) => listeners.set(event, callback))
      }
      children.push({ pid: child.pid, kill: child.kill, listeners })
      return child as never
    })

    const commit = generateCommitMessageFromContext(
      {
        branch: 'main',
        stagedSummary: 'M\tREADME.md',
        stagedPatch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'local',
        cwd: '/repo'
      }
    )
    const pullRequest = generatePullRequestFieldsFromContext(
      {
        branch: 'feature/pr-fields',
        base: 'main',
        branchChangedByPreparation: false,
        currentTitle: '',
        currentBody: '',
        currentDraft: false,
        commitSummary: '- feat: update README',
        changeSummary: 'M\tREADME.md',
        patch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'local',
        cwd: '/repo'
      }
    )

    cancelGeneratePullRequestFieldsLocal('/repo')

    expect(children[0]?.kill).not.toHaveBeenCalled()
    expectChildTerminated(children[1]!)

    const commitStdout = children[0]?.listeners.get('stdout:data')
    commitStdout?.(Buffer.from('Update README\n'))
    children[0]?.listeners.get('close')?.(0)
    children[1]?.listeners.get('close')?.(null)

    await expect(commit).resolves.toEqual({
      success: true,
      message: 'Update README',
      agentLabel: 'agent'
    })
    await expect(pullRequest).resolves.toEqual({
      success: false,
      error: 'Generation canceled.',
      canceled: true,
      branchChangedByPreparation: false
    })
  })

  it('reports branch changes when pull request generation is canceled', async () => {
    const listeners = new Map<string, (value: unknown) => void>()
    const child = {
      pid: 123,
      kill: vi.fn(),
      stdout: { on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)) },
      stderr: { on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)) },
      stdin: { end: vi.fn() },
      on: vi.fn((event, callback) => listeners.set(event, callback))
    }
    spawnMock.mockReturnValue(child as never)

    const pullRequest = generatePullRequestFieldsFromContext(
      {
        branch: 'feature/pr-fields',
        base: 'main',
        branchChangedByPreparation: true,
        currentTitle: '',
        currentBody: '',
        currentDraft: false,
        commitSummary: '- feat: update README',
        changeSummary: 'M\tREADME.md',
        patch: '+hello'
      },
      {
        agentId: 'custom',
        model: '',
        customAgentCommand: 'agent'
      },
      {
        kind: 'local',
        cwd: '/repo'
      }
    )

    cancelGeneratePullRequestFieldsLocal('/repo')
    listeners.get('close')?.(null)

    expectChildTerminated(child)
    await expect(pullRequest).resolves.toEqual({
      success: false,
      error: 'Generation canceled.',
      canceled: true,
      branchChangedByPreparation: true
    })
  })

  it('settles local commit-message cancellation even when the killed child does not close', async () => {
    vi.useFakeTimers()
    try {
      const listeners = new Map<string, (value: unknown) => void>()
      const removeListener = (key: string, callback: (value: unknown) => void): void => {
        if (listeners.get(key) === callback) {
          listeners.delete(key)
        }
      }
      const child = {
        pid: 123,
        kill: vi.fn(),
        stdout: {
          on: vi.fn((event, callback) => listeners.set(`stdout:${event}`, callback)),
          off: vi.fn((event, callback) => removeListener(`stdout:${event}`, callback))
        },
        stderr: {
          on: vi.fn((event, callback) => listeners.set(`stderr:${event}`, callback)),
          off: vi.fn((event, callback) => removeListener(`stderr:${event}`, callback))
        },
        stdin: { end: vi.fn() },
        on: vi.fn((event, callback) => listeners.set(event, callback)),
        off: vi.fn((event, callback) => removeListener(event, callback))
      }
      spawnMock.mockReturnValue(child as never)

      const pending = generateCommitMessageFromContext(
        {
          branch: 'main',
          stagedSummary: 'M\tREADME.md',
          stagedPatch: '+hello'
        },
        {
          agentId: 'custom',
          model: '',
          customAgentCommand: 'agent'
        },
        {
          kind: 'local',
          cwd: '/repo'
        }
      )
      const outcomePromise = pending.then((result) =>
        !result.success && result.canceled ? 'canceled' : 'other'
      )

      cancelGenerateCommitMessageLocal('/repo')
      expectChildTerminated(child)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      const outcome = await Promise.race([outcomePromise, Promise.resolve('pending')])

      expect(outcome).toBe('canceled')
      expect(listeners.has('stdout:data')).toBe(false)
      expect(listeners.has('stderr:data')).toBe(false)
      expect(listeners.has('error')).toBe(false)
      expect(listeners.has('close')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('publishes Codex cancellation immediately but holds its home lock until close', async () => {
    const firstChild = createMockDiscoveryChild()
    const secondChild = createMockDiscoveryChild()
    spawnMock.mockReturnValueOnce(firstChild as never).mockReturnValueOnce(secondChild as never)
    const env = { CODEX_HOME: '/managed/codex-generation-home' }
    const context = { branch: 'main', stagedSummary: 'M\tREADME.md', stagedPatch: '+hello' }
    const params = { agentId: 'codex' as const, model: 'gpt-5.5' }

    const first = generateCommitMessageFromContext(context, params, {
      kind: 'local',
      cwd: '/repo',
      env
    })
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))
    cancelGenerateCommitMessageLocal('/repo')

    await expect(first).resolves.toEqual({
      success: false,
      error: 'Generation canceled.',
      canceled: true
    })
    expectChildTerminated(firstChild)

    const second = generateCommitMessageFromContext(context, params, {
      kind: 'local',
      cwd: '/repo-2',
      env
    })
    await Promise.resolve()
    expect(spawnMock).toHaveBeenCalledTimes(1)

    firstChild.emit('close', null)
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
    secondChild.stdout.emit('data', Buffer.from('Update README\n'))
    secondChild.emit('close', 0)
    await expect(second).resolves.toMatchObject({ success: true, message: 'Update README' })
  })

  it('releases the Codex home lock when the child exits with a descendant holding its stdio', async () => {
    const firstChild = createMockDiscoveryChild()
    const secondChild = createMockDiscoveryChild()
    spawnMock.mockReturnValueOnce(firstChild as never).mockReturnValueOnce(secondChild as never)
    const env = { CODEX_HOME: '/managed/codex-descendant-home' }
    const context = { branch: 'main', stagedSummary: 'M\tREADME.md', stagedPatch: '+hello' }
    const params = { agentId: 'codex' as const, model: 'gpt-5.5' }

    const first = generateCommitMessageFromContext(context, params, {
      kind: 'local',
      cwd: '/descendant-repo',
      env
    })
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))
    cancelGenerateCommitMessageLocal('/descendant-repo')
    await expect(first).resolves.toMatchObject({ canceled: true })
    expectChildTerminated(firstChild)

    // SIGKILL reaches the codex process but not a grandchild that inherited its
    // stdout, so 'exit' arrives and 'close' never does.
    firstChild.emit('exit', null, 'SIGKILL')

    const second = generateCommitMessageFromContext(context, params, {
      kind: 'local',
      cwd: '/descendant-repo-2',
      env
    })
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
    secondChild.stdout.emit('data', Buffer.from('Update README\n'))
    secondChild.emit('close', 0)
    await expect(second).resolves.toMatchObject({ success: true, message: 'Update README' })
  })

  it('holds the Codex home lock until Windows tree termination and wrapper close', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    let finishTreeKill!: () => void
    terminateWindowsProcessTreeMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishTreeKill = resolve
      })
    )
    const firstChild = createMockDiscoveryChild()
    const secondChild = createMockDiscoveryChild()
    spawnMock.mockReturnValueOnce(firstChild as never).mockReturnValueOnce(secondChild as never)
    const env = { CODEX_HOME: 'C:\\managed\\codex-generation-home' }
    const context = { branch: 'main', stagedSummary: 'M\tREADME.md', stagedPatch: '+hello' }
    const params = { agentId: 'codex' as const, model: 'gpt-5.5' }

    try {
      const first = generateCommitMessageFromContext(context, params, {
        kind: 'local',
        cwd: 'C:\\repo',
        env
      })
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))
      cancelGenerateCommitMessageLocal('C:\\repo')
      await expect(first).resolves.toMatchObject({ canceled: true })

      const second = generateCommitMessageFromContext(context, params, {
        kind: 'local',
        cwd: 'C:\\repo-2',
        env
      })
      firstChild.emit('close', null)
      await Promise.resolve()
      expect(spawnMock).toHaveBeenCalledTimes(1)

      finishTreeKill()
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
      secondChild.stdout.emit('data', Buffer.from('Update README\n'))
      secondChild.emit('close', 0)
      await expect(second).resolves.toMatchObject({ success: true, message: 'Update README' })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('cancels Codex generation promptly while it is queued behind the home lock', async () => {
    const discoveryChild = createMockDiscoveryChild()
    const laterChild = createMockDiscoveryChild()
    spawnMock.mockReturnValueOnce(discoveryChild as never).mockReturnValueOnce(laterChild as never)
    const env = { CODEX_HOME: '/managed/codex-queued-home' }
    const blocker = discoverCommitMessageModelsLocal('codex', env)
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))

    const queued = generateCommitMessageFromContext(
      { branch: 'main', stagedSummary: 'M\tREADME.md', stagedPatch: '+hello' },
      { agentId: 'codex', model: 'gpt-5.5' },
      { kind: 'local', cwd: '/queued-repo', env }
    )
    cancelGenerateCommitMessageLocal('/queued-repo')

    await expect(queued).resolves.toEqual({
      success: false,
      error: 'Generation canceled.',
      canceled: true
    })
    expect(spawnMock).toHaveBeenCalledTimes(1)

    discoveryChild.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ models: [{ slug: 'gpt-5.5', display_name: 'GPT-5.5' }] }))
    )
    discoveryChild.emit('close', 0)
    await expect(blocker).resolves.toMatchObject({ success: true })

    const later = generateCommitMessageFromContext(
      { branch: 'main', stagedSummary: 'M\tREADME.md', stagedPatch: '+later' },
      { agentId: 'codex', model: 'gpt-5.5' },
      { kind: 'local', cwd: '/later-repo', env }
    )
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
    laterChild.stdout.emit('data', Buffer.from('Update later\n'))
    laterChild.emit('close', 0)
    await expect(later).resolves.toMatchObject({ success: true, message: 'Update later' })
  })
})

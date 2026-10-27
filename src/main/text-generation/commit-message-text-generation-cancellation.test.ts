import { spawn } from 'node:child_process'
import type * as ChildProcess from 'node:child_process'
import { quoteWindowsArgument } from '@orca/process-host/windows-command-line'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cancelGenerateCommitMessageLocal,
  cancelGeneratePullRequestFieldsLocal,
  discoverCommitMessageModelsLocal,
  generateCommitMessageFromContext,
  generatePullRequestFieldsFromContext
} from './commit-message-text-generation'
import {
  createChildTerminationExpectation,
  createMockDiscoveryChild,
  spawnedAgentArgv,
  withPlatform
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

// Fake Windows direct-child/taskkill paths here; source-control-local-process.test.ts covers supervised POSIX stop and managed-home lock release.
const hostPlatform = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: hostPlatform })
  vi.unstubAllEnvs()
})

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  // Clear PATH so host agent installations cannot answer the fake Windows binary lookup.
  vi.stubEnv('PATH', '')
  terminateWindowsProcessTreeMock.mockClear()
  terminateWindowsProcessTreeMock.mockResolvedValue(undefined)
  spawnMock.mockClear()
})

describe('generateCommitMessageFromContext on the Windows direct-child path', () => {
  const largePatch = Array.from(
    { length: 40 },
    (_, i) => `diff --git a/f${i}.ts b/f${i}.ts\n${`+${'x'.repeat(99)}\n`.repeat(25)}`
  ).join('')
  const pullRequestContext = {
    branch: 'feature/large',
    base: 'main',
    branchChangedByPreparation: false,
    currentTitle: '',
    currentBody: '',
    currentDraft: false,
    commitSummary: '- feat: large change',
    changeSummary: 'M\tf0.ts',
    patch: largePatch
  }
  const local = { kind: 'local' as const, cwd: '/repo', env: { ...process.env } }

  it.each(['plain', 'quote-heavy'])(
    'fits a %s jcode pull-request diff to the quoted Windows command line',
    async (content) => {
      await withPlatform('win32', async () => {
        await generatePullRequestFieldsFromContext(
          {
            ...pullRequestContext,
            patch: content === 'quote-heavy' ? largePatch.replaceAll('x', '"') : largePatch
          },
          // Settings always resolve an action template; this is the default one.
          { agentId: 'jcode', model: 'default', commandInputTemplate: '{basePrompt}' },
          local
        )

        expect(spawnMock).toHaveBeenCalledTimes(1)
        const argv = spawnedAgentArgv(spawnMock.mock.calls[0]).map(String)
        expect(argv.map(quoteWindowsArgument).join(' ').length).toBeLessThanOrEqual(30_000)
        expect(argv.join(' ')).toContain('diff truncated')
      })
    }
  )

  it('truncates a multi-byte diff so a jcode commit prompt fits the Linux single-argument cap', async () => {
    await withPlatform('linux', async () => {
      // Three UTF-8 bytes per character: the cap is in bytes, the diff budget in characters.
      await generateCommitMessageFromContext(
        {
          branch: 'main',
          stagedSummary: 'M\tf0.ts',
          stagedPatch: largePatch.replaceAll('x', '\u4e2d').repeat(4)
        },
        { agentId: 'jcode', model: 'default' },
        local
      )

      expect(spawnMock).toHaveBeenCalledTimes(1)
      const argv = spawnedAgentArgv(spawnMock.mock.calls[0]).map(String)
      expect(Math.max(...argv.map((arg) => Buffer.byteLength(arg)))).toBeLessThanOrEqual(120 * 1024)
      const prompt = argv.join(' ')
      expect(prompt).toContain('diff truncated')
      expect(prompt.split('diff --git').length - 1).toBeGreaterThan(100)
    })
  })

  it('leaves a WSL argv prompt to the guard because the WSL launcher re-wraps the command', async () => {
    await withPlatform('win32', async () => {
      const pending = generatePullRequestFieldsFromContext(
        pullRequestContext,
        { agentId: 'jcode', model: 'default' },
        { ...local, wslDistro: 'Ubuntu' }
      )

      await expect(pending).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('too large for the Windows command line')
      })
      expect(spawnMock).not.toHaveBeenCalled()
    })
  })

  it('fails clearly before spawning when the rest of an argv prompt exceeds the Windows command line', async () => {
    await withPlatform('win32', async () => {
      const pending = generatePullRequestFieldsFromContext(
        { ...pullRequestContext, currentBody: 'x'.repeat(40_000) },
        { agentId: 'jcode', model: 'default' },
        local
      )

      await expect(pending).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('too large for the Windows command line')
      })
      expect(spawnMock).not.toHaveBeenCalled()
    })
  })

  it('fails clearly before spawning when the rest of an argv prompt exceeds the Linux single-argument cap', async () => {
    await withPlatform('linux', async () => {
      const pending = generatePullRequestFieldsFromContext(
        // Exceed Linux's per-argument MAX_ARG_STRLEN, not merely Windows' smaller total command budget.
        { ...pullRequestContext, currentBody: 'x'.repeat(140_000) },
        { agentId: 'jcode', model: 'default' },
        local
      )

      await expect(pending).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('single command-line argument')
      })
      expect(spawnMock).not.toHaveBeenCalled()
    })
  })

  it('still spawns on Linux with the whole diff for a prompt that only Windows would refuse', async () => {
    await withPlatform('linux', async () => {
      // Stay below Linux argument capacity while exceeding Windows line budget; do not impose one platform's minimum on all.
      await generateCommitMessageFromContext(
        {
          branch: 'main',
          stagedSummary: 'M\tREADME.md',
          stagedPatch: `+${'x'.repeat(40_000)}`
        },
        { agentId: 'jcode', model: 'default' },
        local
      )
      expect(spawnMock).toHaveBeenCalled()
      expect(spawnedAgentArgv(spawnMock.mock.calls[0]).join(' ')).not.toContain('diff truncated')
    })
  })

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

    await expectChildTerminated(children[0]!)
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
    await expectChildTerminated(children[1]!)

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

    await expectChildTerminated(child)
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
      await expectChildTerminated(child)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      const outcome = await Promise.race([outcomePromise, Promise.resolve('pending')])

      expect(outcome).toBe('canceled')
      expect(listeners.has('stdout:data')).toBe(false)
      expect(listeners.has('stderr:data')).toBe(false)
      expect(listeners.has('error')).toBe(true)
      expect(listeners.has('close')).toBe(true)
      listeners.get('close')?.(null)
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
    await expectChildTerminated(firstChild)

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

  it('releases the Codex home on root exit when a descendant holds stdio open', async () => {
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
    await expectChildTerminated(firstChild)

    // A grandchild retains stdout after root exit, so close never arrives.
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

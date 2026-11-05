import { hydrateRepo } from '../../../persistence/tracking-repos/repo-hydration'
import type { Repo } from '../../../../shared/repo-types'
import { runtimeGitGenerationTargetCurrent } from './runtime-git-generation-context'
import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeGitCommandHost, RuntimeGitTarget } from './runtime-git-command-target'
import type { SourceControlGenerationRequestIdentity } from '../../../text-generation/source-control-generation-lanes'

const mocks = vi.hoisted(() => ({
  output: vi.fn(),
  spawn: vi.fn(),
  stagedContext: vi.fn(),
  reviewContext: vi.fn(),
  issue: vi.fn(),
  environment: vi.fn(),
  template: vi.fn()
}))

vi.mock('../../../git/source-control/staged-commit-context', () => ({
  getStagedCommitContext: mocks.stagedContext
}))
vi.mock('../../../git/command-runner/git-exec-file', () => ({
  gitExecFileAsync: () => {
    throw new Error('No real Git execution authorized')
  }
}))
vi.mock('../../../text-generation/pull-request-context', () => ({
  getPullRequestDraftContext: mocks.reviewContext
}))
vi.mock('../../../source-control/pull-request-linked-issue', () => ({
  loadPullRequestLinkedIssue: mocks.issue
}))
vi.mock('../../../text-generation/commit-message-agent-environment', () => ({
  prepareLocalCommitMessageAgentEnv: mocks.environment
}))
vi.mock('../../../source-control/pull-request-template', () => ({
  resolveHostedReviewBodyForGeneration: mocks.template
}))
vi.mock('../../../providers/local-git-provider', () => ({
  createLocalGitProvider: () => {
    throw new Error('No real Git provider authorized')
  }
}))
vi.mock('../../../providers/local-filesystem-provider', () => ({
  createLocalFilesystemProvider: () => {
    throw new Error('No real filesystem provider authorized')
  }
}))
vi.mock('../../../git/worktrees/content-paths/worktree-shared-directories', () => ({
  getWorktreeSharedLinkPaths: () => {
    throw new Error('No worktree shared path lookup expected')
  }
}))
vi.mock('../../../text-generation/commit-message-model-discovery', () => ({
  discoverModelsLocal: () => {
    throw new Error('No model discovery authorized')
  }
}))
vi.mock('../../../text-generation/source-control-agent-launch', () => ({
  spawnSourceControlAgent: mocks.spawn
}))
vi.mock('../../../pty/process-retirement/windows-process-tree-kill', () => ({
  terminateWindowsProcessTree: () => {
    throw new Error('No real Windows tree stop authorized')
  }
}))
vi.mock('../../../provider-process/supervised-child-process-stop', () => ({
  stopSupervisedChildProcess: async () => {}
}))

import { RuntimeGitGenerationCommands } from './runtime-git-generation-commands'
import { SSH_HOST_NOT_SERVED_MESSAGE } from '../../../providers/ssh-host-not-served-error'

const params = { agentId: 'codex', model: 'gpt-5.5' } as const
const settings = { sourceControlAiResolvedParams: params }
const input = { base: 'main', title: '', body: '', draft: false, provider: 'gitlab' } as const
const stagedContext = { branch: 'main', stagedSummary: 'M README.md', stagedPatch: '+hello' }
const reviewContext = {
  base: 'main',
  branch: 'feature/change',
  commitSummary: 'abc123 Update README',
  changeSummary: 'M README.md',
  patch: '+hello',
  currentTitle: '',
  currentBody: '',
  currentDraft: false
}
const selectedEnvironment = {
  CODEX_HOME: '/offline-selected-account',
  OFFLINE_IDENTITY: 'same-account'
}
const environmentResolvers = { prepareForCodexLaunch: () => '/offline-selected-account' }
const operationCases = ['commit-message', 'pull-request-fields'] as const

function target(
  path = '/repo',
  executionHostId: RuntimeGitTarget['executionHostId'] = 'local'
): RuntimeGitTarget {
  return {
    executionHostId,
    worktree: {
      head: 'a'.repeat(40),
      branch: 'main',
      isBare: false,
      isMainWorktree: false,
      id: `id:${path}`,
      repoId: 'repo-1',
      path,
      displayName: 'offline',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      git: { path, branch: 'main', isBare: false, isMainWorktree: false, head: 'a'.repeat(40) }
    }
  }
}

function commands(value = target()): RuntimeGitGenerationCommands {
  const host: RuntimeGitCommandHost = {
    resolveRuntimeGitTarget: async () => value,
    getRuntimeSettings: () => {
      throw new Error('Resolved parameters avoid settings lookup')
    },
    getCommitMessageAgentEnvironment: () => environmentResolvers
  }
  return new RuntimeGitGenerationCommands(host)
}

function generate(
  owner: RuntimeGitGenerationCommands,
  operation: (typeof operationCases)[number],
  identity?: SourceControlGenerationRequestIdentity
) {
  mocks.output.mockReturnValue(
    operation === 'commit-message'
      ? 'Update README'
      : JSON.stringify({ base: 'main', title: 'Update README', body: '', draft: false })
  )
  return operation === 'commit-message'
    ? owner.generateRuntimeCommitMessage('id:offline', settings, identity)
    : owner.generateRuntimePullRequestFields('id:offline', input, settings, identity)
}

async function expectRequestReleased(
  owner: RuntimeGitGenerationCommands,
  operation: (typeof operationCases)[number],
  identity: SourceControlGenerationRequestIdentity
) {
  await expect(generate(owner, operation, identity)).resolves.toHaveProperty('success', true)
}

function cancel(
  owner: RuntimeGitGenerationCommands,
  operation: (typeof operationCases)[number],
  identity?: SourceControlGenerationRequestIdentity
) {
  return operation === 'commit-message'
    ? owner.cancelRuntimeGenerateCommitMessage('id:offline', identity)
    : owner.cancelRuntimeGeneratePullRequestFields('id:offline', identity)
}

class RuntimeGenerationChild extends ChildProcess {
  override stdout = new PassThrough()
  override stderr = new PassThrough()
  override stdin = new PassThrough()
  override kill = vi.fn(() => true)
}

describe('Runtime generation exact request cancellation', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.stagedContext.mockResolvedValue(stagedContext)
    mocks.reviewContext.mockResolvedValue(reviewContext)
    mocks.issue.mockResolvedValue(null)
    mocks.template.mockImplementation(async ({ body }) => body)
    mocks.environment.mockResolvedValue({ ok: true, env: selectedEnvironment })
    mocks.output.mockReturnValue('Update README')
    mocks.spawn.mockImplementation(() => {
      const child = new RuntimeGenerationChild()
      const output = mocks.output()
      setImmediate(() => {
        child.stdout?.emit('data', Buffer.from(output))
        child.emit('exit', 0)
        child.emit('close', 0)
      })
      return child
    })
  })

  it('keeps runtime ownership across hydrated reads and rejects replacement or route changes', async () => {
    let repo: Repo = {
      id: 'repo-1',
      path: '/repo',
      displayName: 'Repo',
      badgeColor: '',
      addedAt: 1
    }
    const host: RuntimeGitCommandHost = {
      resolveRuntimeGitTarget: async () => ({ ...target(), repo: hydrateRepo(repo, new Map()) }),
      getRuntimeSettings: () => ({})
    }
    const original = await host.resolveRuntimeGitTarget('id:offline')
    expect((await host.resolveRuntimeGitTarget('id:offline')).repo).not.toBe(original.repo)
    expect(await runtimeGitGenerationTargetCurrent(host, 'id:offline', original)).toBe(true)
    repo.path = '/moved'
    expect(await runtimeGitGenerationTargetCurrent(host, 'id:offline', original)).toBe(false)
    repo.path = '/repo'
    repo = { ...repo }
    expect(await runtimeGitGenerationTargetCurrent(host, 'id:offline', original)).toBe(false)
  })

  it.each(['context', 'environment'] as const)(
    'Stop during %s starts no child',
    async (boundary) => {
      const contextGate = Promise.withResolvers<typeof stagedContext>()
      const environmentGate = Promise.withResolvers<{ ok: true; env: typeof selectedEnvironment }>()
      if (boundary === 'context') {
        mocks.stagedContext.mockReturnValue(contextGate.promise)
      } else {
        mocks.environment.mockReturnValue(environmentGate.promise)
      }
      const owner = commands()
      const identity = { owner: 'window:offline', generationId: 'request-A' }
      const result = owner.generateRuntimeCommitMessage('id:offline', settings, identity)
      await nextTurn()
      expect(mocks.spawn).not.toHaveBeenCalled()
      await expect(
        owner.cancelRuntimeGenerateCommitMessage('id:offline', identity)
      ).resolves.toEqual({ ok: true })
      if (boundary === 'context') {
        contextGate.resolve(stagedContext)
      } else {
        environmentGate.resolve({ ok: true, env: selectedEnvironment })
      }
      await expect(result).resolves.toMatchObject({ success: false, canceled: true })
      expect(mocks.spawn).not.toHaveBeenCalled()
      await expectRequestReleased(owner, 'commit-message', identity)
    }
  )
  for (const operation of operationCases) {
    it(`${operation}: Stop during target admission skips context and process`, async () => {
      const admission = Promise.withResolvers<RuntimeGitTarget>()
      const resolveRuntimeGitTarget = vi
        .fn()
        .mockReturnValueOnce(admission.promise)
        .mockResolvedValue(target())
      const owner = new RuntimeGitGenerationCommands({
        resolveRuntimeGitTarget,
        getRuntimeSettings: () => {
          throw new Error('Unused settings')
        }
      })
      const identity = { owner: 'device:one', generationId: 'admitting' }
      const result = generate(owner, operation, identity)
      await expect(cancel(owner, operation, identity)).resolves.toEqual({ ok: true })
      admission.resolve(target())
      await expect(result).resolves.toMatchObject({ success: false, canceled: true })
      expect(mocks.stagedContext).not.toHaveBeenCalled()
      expect(mocks.reviewContext).not.toHaveBeenCalled()
      expect(mocks.spawn).not.toHaveBeenCalled()
      await expectRequestReleased(owner, operation, identity)
    })

    it(`${operation}: delayed Stop A cannot cancel B on the same path`, async () => {
      const stopAdmission = Promise.withResolvers<RuntimeGitTarget>()
      const preparation = Promise.withResolvers<typeof stagedContext | typeof reviewContext>()
      const contextMock = operation === 'commit-message' ? mocks.stagedContext : mocks.reviewContext
      contextMock.mockReturnValueOnce(preparation.promise)
      const resolveRuntimeGitTarget = vi
        .fn()
        .mockResolvedValueOnce(target())
        .mockReturnValueOnce(stopAdmission.promise)
        .mockResolvedValue(target())
      const owner = new RuntimeGitGenerationCommands({
        resolveRuntimeGitTarget,
        getRuntimeSettings: () => {
          throw new Error('Unused settings')
        }
      })
      const a = { owner: 'device:one', generationId: 'A' }
      const b = { owner: 'device:one', generationId: 'B' }
      const resultA = generate(owner, operation, a)
      await nextTurn()
      const stopA = cancel(owner, operation, a)
      const resultB = generate(owner, operation, b)
      await nextTurn()
      stopAdmission.resolve(target())
      await stopA
      preparation.resolve(operation === 'commit-message' ? stagedContext : reviewContext)
      await expect(resultA).resolves.toMatchObject({ success: false, canceled: true })
      await expect(resultB).resolves.toHaveProperty('success', true)
      expect(mocks.spawn).toHaveBeenCalledOnce()
      await expectRequestReleased(owner, operation, a)
      await expectRequestReleased(owner, operation, b)
    })

    it(`${operation}: distinct owners and targets cannot stop the admitted request`, async () => {
      const preparation = Promise.withResolvers<{ ok: true; env: typeof selectedEnvironment }>()
      mocks.environment.mockReturnValue(preparation.promise)
      const owner = commands()
      const identity = { owner: 'device:one', generationId: 'same-id' }
      const result = generate(owner, operation, identity)
      await nextTurn()
      await cancel(owner, operation, { ...identity, owner: 'device:two' })
      await cancel(commands(target('/other')), operation, identity)
      const wsl = target()
      wsl.localGitOptions = { wslDistro: 'Ubuntu' }
      await cancel(commands(wsl), operation, identity)
      await cancel(owner, operation, { ...identity, generationId: 'unknown-id' })
      preparation.resolve({ ok: true, env: selectedEnvironment })
      await expect(result).resolves.toHaveProperty('success', true)
      expect(mocks.spawn).toHaveBeenCalledOnce()
    })

    it(`${operation}: no-ID legacy generation still follows the existing preparation policy`, async () => {
      const preparation = Promise.withResolvers<{ ok: true; env: typeof selectedEnvironment }>()
      mocks.environment.mockReturnValue(preparation.promise)
      const owner = commands()
      const result = generate(owner, operation)
      await nextTurn()
      await cancel(owner, operation)
      preparation.resolve({ ok: true, env: selectedEnvironment })
      await expect(result).resolves.toHaveProperty('success', true)
      expect(mocks.spawn).toHaveBeenCalledOnce()
    })

    it(`${operation}: Stop that lands before Generate registers starts it canceled`, async () => {
      const owner = commands()
      const identity = { owner: 'device:one', generationId: 'not-admitted-yet' }
      await expect(cancel(owner, operation, identity)).resolves.toEqual({ ok: true })
      await expect(generate(owner, operation, identity)).resolves.toMatchObject({
        success: false,
        canceled: true
      })
      expect(mocks.spawn).not.toHaveBeenCalled()
      await expect(generate(owner, operation, identity)).resolves.toHaveProperty('success', true)
      expect(mocks.spawn).toHaveBeenCalledOnce()
    })

    it(`${operation}: an early Stop for another owner, ID or path leaves Generate running`, async () => {
      const identity = { owner: 'device:one', generationId: 'early-other' }
      await cancel(commands(), operation, { ...identity, owner: 'device:two' })
      await cancel(commands(), operation, { ...identity, generationId: 'early-other-id' })
      await cancel(commands(target('/other')), operation, identity)
      await expect(generate(commands(), operation, identity)).resolves.toHaveProperty(
        'success',
        true
      )
      expect(mocks.spawn).toHaveBeenCalledOnce()
    })

    it(`${operation}: exact SSH Stop cannot affect same-path local work`, async () => {
      const preparation = Promise.withResolvers<{ ok: true; env: typeof selectedEnvironment }>()
      mocks.environment.mockReturnValue(preparation.promise)
      const identity = { owner: 'device:one', generationId: 'local' }
      const result = generate(commands(), operation, identity)
      await nextTurn()
      const remote = commands(target('/repo', 'ssh:other'))
      await cancel(remote, operation, identity)
      await expect(
        generate(remote, operation, { ...identity, generationId: 'remote' })
      ).resolves.toEqual({ success: false, error: SSH_HOST_NOT_SERVED_MESSAGE })
      preparation.resolve({ ok: true, env: selectedEnvironment })
      await expect(result).resolves.toHaveProperty('success', true)
      expect(mocks.spawn).toHaveBeenCalledOnce()
    })
  }

  it.each(['template', 'context', 'issue', 'environment'] as const)(
    'review Stop during %s prevents process start and keeps branch preparation state',
    async (boundary) => {
      const contextGate = Promise.withResolvers<
        typeof reviewContext & { branchChangedByPreparation: boolean }
      >()
      const templateGate = Promise.withResolvers<string>()
      const issueGate = Promise.withResolvers<null>()
      const environmentGate = Promise.withResolvers<{ ok: true; env: typeof selectedEnvironment }>()
      const context = { ...reviewContext, branchChangedByPreparation: true }
      mocks.reviewContext.mockResolvedValue(context)
      if (boundary === 'context') {
        mocks.reviewContext.mockReturnValue(contextGate.promise)
      }
      if (boundary === 'template') {
        mocks.template.mockReturnValue(templateGate.promise)
      }
      if (boundary === 'issue') {
        mocks.issue.mockReturnValue(issueGate.promise)
      }
      if (boundary === 'environment') {
        mocks.environment.mockReturnValue(environmentGate.promise)
      }
      const owner = commands()
      const identity = { owner: 'window:one', generationId: 'review' }
      const result = generate(owner, 'pull-request-fields', identity)
      await nextTurn()
      await cancel(owner, 'pull-request-fields', identity)
      contextGate.resolve(context)
      templateGate.resolve('')
      issueGate.resolve(null)
      environmentGate.resolve({ ok: true, env: selectedEnvironment })
      await expect(result).resolves.toMatchObject({
        success: false,
        canceled: true,
        ...(boundary === 'template' ? {} : { branchChangedByPreparation: true })
      })
      expect(mocks.spawn).not.toHaveBeenCalled()
      await expectRequestReleased(owner, 'pull-request-fields', identity)
    }
  )

  it('surviving request retains exact model, prompt, selected home, environment and route', async () => {
    const identity = { owner: 'window:one', generationId: 'success' }
    const owner = commands()
    await expect(generate(owner, 'commit-message', identity)).resolves.toMatchObject({
      success: true,
      message: 'Update README'
    })
    expect(mocks.spawn).toHaveBeenCalledOnce()
    expect(mocks.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/repo',
        env: selectedEnvironment,
        stdinMode: 'pipe',
        useCwdForNative: true,
        args: expect.arrayContaining(['--model', 'gpt-5.5'])
      })
    )
    await expectRequestReleased(owner, 'commit-message', identity)
  })
})

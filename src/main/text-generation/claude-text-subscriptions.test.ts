import {
  claudeTextSubscriptionFixture as fixture,
  cleanupClaudeTextSubscriptions
} from './claude-text-subscription.test-fixture'
import { sourceControlSubscriptionTarget } from './source-control-subscription-target'
import {
  generateCommitMessage,
  generatePullRequestFields
} from './source-control-text-generation-requests'
import { generateConversationName } from './conversation-name-generation-request'
import { generateJiraIssueSummaryFromContext } from './jira-issue-summary-text-generation'
import {
  generateJiraIssueSummaryRequest,
  cancelJiraIssueSummaryRequest
} from './jira-issue-summary-requests'
import { structuredChatNamingDeps } from '../runtime/structured-chat-naming-runtime'
import { agentSessionRecordFixture } from '../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { normalizeSourceControlAiSettings } from '../../shared/source-control-ai'
import type * as GitRunner from '../git/runner'
import type * as ClaudeKeychain from '../claude-accounts/keychain'
import { utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  beginLocalGenerationRequest,
  beginTextGenerationRequest,
  cancelLocalGeneration
} from './source-control-generation-lanes'
import { runGenerationRequest as currentRunner } from './agent-generation-request'
import {
  maybeAutoRenameBranchOnFirstWork,
  resetFirstWorkBranchRenameState
} from '../agent-hooks/first-work-branch-rename'
import { workingEvent, gitResponder } from '../agent-hooks/first-work-branch-rename-test-harness'
import { spawnSourceControlAgent } from './source-control-agent-launch'

vi.mock('../jira/client', () => ({ getStatus: () => ({ sites: [{ id: 'site' }] }) }))

const gitMock = vi.hoisted(() => vi.fn())
vi.mock('../git/runner', async (original) => ({
  ...(await original<typeof GitRunner>()),
  gitExecFileAsync: gitMock
}))
vi.mock('../git/git-username', () => ({ resolveLocalGitUsername: async () => 'you' }))
vi.mock('../network/proxy-settings', () => ({ ensureElectronProxyFromEnvironment: async () => {} }))
// Credentials stay in disposable homes even when these tests run on macOS.
vi.mock('../claude-accounts/keychain', async (original) => ({
  ...(await original<typeof ClaudeKeychain>()),
  readActiveClaudeKeychainCredentialsStrict: async () => null
}))
vi.mock('../startup/login-shell-environment', () => ({
  resolveLoginShellEnvironment: async () => ({})
}))

afterEach(() => {
  cleanupClaudeTextSubscriptions()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe.skipIf(process.platform === 'win32')(
  'managed Claude text subscription subprocess delivery',
  () => {
    it('runs B with its real fixed environment after A refuses, keeping model, context and permissions', async () => {
      const f = await fixture()
      const result = await f.run()
      const attempts = f.attempts()
      expect(attempts.map((a) => a.account)).toEqual(['a', 'b'])
      expect(result).toMatchObject({ success: true, rawOutput: 'fix-auth' })
      expect(attempts[1].home).toBe(f.home('b'))
      expect(attempts[1].pointer).toBeUndefined()
      expect(attempts[0].input).toBe(attempts[1].input)
      expect(attempts[0].args).toEqual(attempts[1].args)
      expect(attempts[1].args).toContain('claude-sonnet-5')
      expect(f.settings.activeClaudeManagedAccountId).toBe('a')
    })
    it('preserves enabled usage credits without changing billing settings', async () => {
      const f = await fixture({ overflowDisabled: false })
      expect(await f.run()).toMatchObject({ success: true, rawOutput: 'fix-auth' })
    })
    it('accepts a newer CLI and keeps an older one on ordinary execution with one warning', async () => {
      const newer = await fixture({ version: '2.2.0 (Claude Code)' })
      expect(await newer.run()).toMatchObject({ success: true, rawOutput: 'fix-auth' })
      expect(newer.attempts().map((a) => a.account)).toEqual(['a', 'b'])
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      for (let run = 0; run < 2; run += 1) {
        const older = await fixture({ version: '2.1.316 (Claude Code)' })
        expect(await older.run()).toMatchObject({ success: false })
        expect(older.attempts().map((a) => a.account)).toEqual(['a'])
        expect(older.attempts()[0].args).not.toContain('stream-json')
      }
      expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('2.1.316'))
    })
    it('continues after a same-identity token refresh but not after a login change', async () => {
      const f = await fixture()
      try {
        const attempts = await Promise.all(['a', 'b'].map((id) => f.subscription!.prepare(id)))
        for (const [index, id] of ['a', 'b'].entries()) {
          writeFileSync(
            join(f.home(id), '.credentials.json'),
            JSON.stringify({ claudeAiOauth: { accessToken: `${id}-refreshed` } })
          )
          expect(await attempts[index]!.valid()).toBe(true)
        }
        writeFileSync(
          join(f.home('b'), '.claude.json'),
          JSON.stringify({
            oauthAccount: { emailAddress: 'other@example.test', organizationUuid: 'org-b' }
          })
        )
        expect(await attempts[1]!.valid()).toBe(false)
        expect(await f.subscription!.prepare('b')).toBeNull()
      } finally {
        f.request.finish()
      }
    })
    it('checks the CLI version once per install and again after it changes', async () => {
      const f = await fixture()
      try {
        expect(await f.subscription!.prepare('a')).not.toBeNull()
        const env = { ...f.env, ORCA_TEST_CLAUDE_VERSION: '2.1.316 (Claude Code)' }
        const later = () => f.prepare({ params: f.params, cwd: f.root, env, request: f.request })
        expect(await later()!.prepare('a')).not.toBeNull()
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        const binary = join(f.root, 'bin', 'claude')
        utimesSync(binary, new Date(), new Date(Date.now() + 60_000))
        expect(await later()!.prepare('a')).toBeNull()
      } finally {
        f.request.finish()
      }
    })
    it('reuses the model listing for a later request until the configuration changes', async () => {
      const f = await fixture()
      try {
        expect(await f.subscription!.prepare('a')).not.toBeNull()
        const later = () =>
          f.prepare({ params: f.params, cwd: f.root, env: f.env, request: f.request })
        const claim = vi.spyOn(f.request, 'claimSpawn')
        expect(await later()!.prepare('a')).not.toBeNull()
        expect(claim).not.toHaveBeenCalled()
        writeFileSync(join(f.root, 'CLAUDE.md'), 'Prefer short names.')
        expect(await later()!.prepare('a')).not.toBeNull()
        expect(claim).toHaveBeenCalledOnce()
      } finally {
        f.request.finish()
      }
    })
    it('keeps opt-out single attempt', async () => {
      const f = await fixture({ enabled: false })
      expect(await f.run()).toMatchObject({ success: false })
      expect(f.attempts().map((a) => a.account)).toEqual(['a'])
    })
    it('does not replace a custom command', async () => {
      const f = await fixture()
      expect(
        f.prepare({
          params: { ...f.params, agentCommandOverride: 'custom' },
          cwd: f.root,
          env: f.env,
          request: f.request
        })
      ).toBeUndefined()
      expect(await f.run({ agentCommandOverride: join(f.root, 'bin', 'claude') })).toMatchObject({
        success: false
      })
      expect(f.attempts().map((a) => a.account)).toEqual(['a'])
    })
    it('retains the first refusal when every eligible account is exhausted', async () => {
      const f = await fixture({ behavior: { a: 'quota', b: 'quota', c: 'quota' } })
      f.limits.delete('d')
      const result = await f.run()
      expect(result).toMatchObject({
        success: false,
        subscriptionQuotaRefused: true,
        subscriptionRecovery: { attemptedCount: 3, reason: 'exhausted' }
      })
      expect(f.attempts().map((attempt) => attempt.account)).toEqual(['a', 'b', 'c'])
      if (!result.success) {
        expect(result.subscriptionRecovery?.firstError).toContain('Provider refusal')
      }
    })
    it('keeps an explicit account home pinned through ordinary runner delivery', async () => {
      const f = await fixture()
      const env = { ...f.env, CLAUDE_CONFIG_DIR: f.home('b') }
      try {
        const subscription = f.prepare({ params: f.params, cwd: f.root, env, request: f.request })
        expect(subscription).toBeUndefined()
        expect(
          await currentRunner({
            params: f.params,
            prompt: 'Pinned context',
            target: { kind: 'local', cwd: f.root, env, request: f.request, subscription },
            operation: 'branch-name',
            spawnAgent: spawnSourceControlAgent
          })
        ).toMatchObject({ success: true })
        expect(f.attempts().map((attempt) => attempt.account)).toEqual(['b'])
      } finally {
        f.request.finish()
      }
    })
    it('does not rotate after an authentication failure on A', async () => {
      const f = await fixture({ behavior: { a: 'auth', b: 'success' } })
      expect(await f.run()).toMatchObject({ success: false, subscriptionQuotaRefused: false })
      expect(f.attempts().map((attempt) => attempt.account)).toEqual(['a'])
    })
    it('keeps Stop sticky while B preparation is pending', async () => {
      const f = await fixture()
      let entered!: () => void
      let release!: () => void
      const preparing = new Promise<void>((resolve) => {
        entered = resolve
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const original = f.auth.prepareAccountFolder
      vi.spyOn(f.auth, 'prepareAccountFolder').mockImplementation(async (id) => {
        if (id === 'b') {
          entered()
          await gate
        }
        return original(id)
      })
      const pending = f.run()
      await preparing
      cancelLocalGeneration('branch-name', f.root)
      release()
      expect(await pending).toMatchObject({ success: false, canceled: true })
      expect(f.attempts().map((a) => a.account)).toEqual(['a'])
    })
  }
)

describe.skipIf(process.platform === 'win32')('request-owned subscription recovery', () => {
  it('honors Stop during B preparation without canceling another owner in the same cwd', async () => {
    const f = await fixture()
    f.request.finish()
    const a = beginTextGenerationRequest(
      'branch-name',
      f.root,
      60000,
      () => true,
      undefined,
      'owner-a'
    )
    const b = beginTextGenerationRequest(
      'branch-name',
      f.root,
      60000,
      () => true,
      undefined,
      'owner-b'
    )
    let entered = 0
    const ready = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const preparation: Promise<unknown>[] = []
    const original = f.auth.prepareAccountFolder
    vi.spyOn(f.auth, 'prepareAccountFolder').mockImplementation((id) => {
      const pending = (async () => {
        if (id === 'b') {
          if (++entered === 2) {
            ready.resolve()
          }
          await gate.promise
        }
        return original(id)
      })()
      preparation.push(pending)
      return pending
    })
    const run = async (request: typeof a, prompt: string) => {
      try {
        const subscription = f.prepare({ params: f.params, cwd: f.root, env: f.env, request })
        return await currentRunner({
          params: f.params,
          prompt,
          target: { kind: 'local', cwd: f.root, env: f.env, request, subscription },
          operation: 'branch-name',
          spawnAgent: spawnSourceControlAgent
        })
      } finally {
        request.finish()
      }
    }
    const first = run(a, 'owner-a')
    const second = run(b, 'owner-b')
    await ready.promise
    a.cancel()
    expect(await first).toMatchObject({ success: false, canceled: true })
    expect(b.current()).toBe(true)
    gate.resolve()
    expect(await second).toMatchObject({ success: true, rawOutput: 'fix-auth' })
    await Promise.all(preparation)
    expect(
      f
        .attempts()
        .filter((attempt) => attempt.account === 'b')
        .map((attempt) => attempt.input)
    ).toEqual(['owner-b'])
  })
  it('returns an environment failure when ordinary recovery preparation also fails', async () => {
    const f = await fixture()
    try {
      expect(
        await currentRunner({
          params: f.params,
          prompt: 'Fixed context',
          operation: 'branch-name',
          spawnAgent: spawnSourceControlAgent,
          target: {
            kind: 'local',
            cwd: f.root,
            env: f.env,
            request: f.request,
            subscription: {
              ...f.subscription!,
              prepare: async () => null,
              fallbackEnvironment: async () => {
                throw new Error('Account unavailable')
              }
            }
          }
        })
      ).toMatchObject({ success: false, error: 'Could not prepare the generation environment.' })
      expect(f.attempts()).toEqual([])
    } finally {
      f.request.finish()
    }
  })
  it('ends a preparation deadline as a failure so rename backoff remains available', async () => {
    const f = await fixture()
    f.request.finish()
    const request = beginTextGenerationRequest('branch-name', f.root, 50, () => true)
    const gate = Promise.withResolvers<void>()
    const original = f.auth.prepareAccountFolder
    const preparing = vi.spyOn(f.auth, 'prepareAccountFolder').mockImplementation(async (id) => {
      await gate.promise
      return original(id)
    })
    try {
      const subscription = f.prepare({ params: f.params, cwd: f.root, env: f.env, request })
      const result = await currentRunner({
        params: f.params,
        prompt: 'Fixed context',
        target: { kind: 'local', cwd: f.root, env: f.env, request, subscription },
        operation: 'branch-name',
        spawnAgent: spawnSourceControlAgent
      })
      // Before any quota refusal a deadline is a plain timeout.
      expect(result).toMatchObject({ success: false, errorCode: 'timedOut' })
      expect(result).not.toHaveProperty('canceled', true)
      expect(f.attempts()).toEqual([])
    } finally {
      gate.resolve()
      await Promise.all(preparing.mock.results.map((result) => result.value))
      request.finish()
    }
  })
  it.each([
    ['an unrelated settings write', { branchPrefix: 'custom' }, ['a', 'b']],
    ['an account selection change', { activeClaudeManagedAccountId: 'c' }, ['a']]
  ] as const)('fences B preparation against %s', async (_change, patch, accounts) => {
    const f = await fixture()
    const original = f.auth.prepareAccountFolder
    vi.spyOn(f.auth, 'prepareAccountFolder').mockImplementation(async (id) => {
      const folder = await original(id)
      if (id === 'b') {
        const written = { ...f.settings, ...patch }
        f.store.getSettings = () => written
      }
      return folder
    })
    expect(await f.run()).toMatchObject(
      accounts.length === 2
        ? { success: true, rawOutput: 'fix-auth' }
        : { success: false, canceled: true }
    )
    expect(f.attempts().map((a) => a.account)).toEqual(accounts)
  })
})

describe.skipIf(process.platform === 'win32')(
  'first-work naming through managed subscription recovery',
  () => {
    it.each(['branch', 'folder'] as const)(
      'applies one %s name from B without another working event',
      async (kind) => {
        resetFirstWorkBranchRenameState()
        const f = await fixture()
        f.request.finish()
        const worktreeId = kind === 'branch' ? `repo1::${f.root}` : 'folder:folder-one'
        const repo = { id: 'repo1', path: f.root, displayName: 'Repo', badgeColor: '', addedAt: 0 }
        let displayName = 'Nautilus'
        let pending = true
        const head = join(f.root, 'HEAD')
        writeFileSync(head, 'ref: refs/heads/Nautilus')
        const git = gitResponder({ currentBranch: 'Nautilus', hasUpstream: false })
        gitMock.mockImplementation((args) =>
          args.includes('--git-path') ? Promise.resolve({ stdout: head, stderr: '' }) : git(args)
        )
        const apply = vi.fn((_id: string, name: string) => {
          displayName = name
          pending = false
        })
        const setError = vi.fn()
        const getAgentEnvResolvers = () => ({
          resolveBaseEnvironment: async () => f.env,
          prepareForClaudeLaunch: async () => ({
            configDir: f.home('a'),
            envPatch: {
              CLAUDE_CONFIG_DIR: f.home('a'),
              ORCA_CLAUDE_INJECTED_CONFIG_DIR: f.home('a')
            },
            provenance: 'profile:a'
          }),
          prepareTextSubscriptionFailover: f.prepare
        })
        const event = workingEvent({ worktreeId, tabId: undefined, paneKey: 'unknown' })
        const deps = {
          getSettings: () => f.settings,
          getRepo: () => repo,
          getAgentEnvResolvers,
          getCurrentDisplayName: () => displayName,
          canRenameOrcaCreatedBranch: () => true,
          getFolderWorkspacePath: () => f.root,
          isPendingFirstAgentMessageRename: () => pending,
          setDisplayName: apply,
          setRenameError: setError,
          resolveWorktreeIdForTab: () => worktreeId,
          onRenamed: vi.fn()
        }
        await maybeAutoRenameBranchOnFirstWork(event, deps)
        expect(f.attempts().map((a) => a.account)).toEqual(['a', 'b'])
        expect(apply).toHaveBeenCalledExactlyOnceWith(worktreeId, 'Fix auth')
        expect(setError).toHaveBeenLastCalledWith(worktreeId, null)
        await maybeAutoRenameBranchOnFirstWork(event, deps)
        expect(apply).toHaveBeenCalledTimes(1)
        expect(f.attempts()).toHaveLength(2)
      }
    )
  }
)

describe.skipIf(process.platform === 'win32')(
  'admitted text caller subscription boundaries',
  () => {
    const recipes = async () => {
      const f = await fixture()
      f.request.finish()
      f.settings.sourceControlAi = {
        ...normalizeSourceControlAiSettings(f.settings.sourceControlAi),
        agentId: 'claude',
        selectedModelByAgent: { claude: 'sonnet' },
        actions: {
          conversationName: { agentId: 'claude', commandInputTemplate: 'Name {firstPrompt}' }
        }
      }
      const resolvers = {
        resolveBaseEnvironment: async () => f.env,
        prepareTextSubscriptionFailover: f.prepare
      }
      return { ...f, resolvers }
    }

    it.each(['commit', 'pr', 'conversation', 'jira'] as const)(
      'parses %s after actual A refusal and B credential delivery',
      async (caller) => {
        const f = await recipes()
        const registration = beginLocalGenerationRequest('commit-message', {
          owner: 'window:test',
          generationId: caller
        })!
        registration.bindTarget({ cwd: f.root })
        const output =
          caller === 'pr'
            ? JSON.stringify({ title: 'Fix auth', body: 'Details', draft: true })
            : 'Fix auth'
        const target = sourceControlSubscriptionTarget(
          {
            kind: 'local',
            cwd: f.root,
            env: { ...f.env, ORCA_TEST_SUBSCRIPTIONS_OUTPUT: output },
            generationRequest: registration
          },
          f.params,
          f.resolvers,
          async () => true
        )
        try {
          const input = { params: f.params, target, spawnAgent: spawnSourceControlAgent }
          const result =
            caller === 'commit'
              ? await generateCommitMessage({
                  ...input,
                  context: { branch: 'feature', stagedSummary: 'auth.ts', stagedPatch: '+fix' }
                })
              : caller === 'pr'
                ? await generatePullRequestFields({
                    ...input,
                    context: {
                      base: 'main',
                      branch: 'feature',
                      currentTitle: '',
                      currentBody: '',
                      currentDraft: false,
                      branchChangedByPreparation: false,
                      commitSummary: 'fix',
                      changeSummary: 'auth.ts',
                      patch: '+fix'
                    }
                  })
                : caller === 'conversation'
                  ? await generateConversationName({
                      ...input,
                      context: { firstPrompt: 'Repair login' }
                    })
                  : await generateJiraIssueSummaryFromContext(
                      { description: 'Repair login' },
                      f.params,
                      target
                    )
          expect(result).toMatchObject(
            caller === 'commit'
              ? { success: true, message: 'Fix auth' }
              : caller === 'pr'
                ? { success: true, fields: { title: 'Fix auth', body: 'Details', draft: true } }
                : caller === 'conversation'
                  ? { success: true, name: 'Fix auth' }
                  : { success: true, summary: 'Fix auth' }
          )
          expect(f.attempts().map((a) => a.account)).toEqual(['a', 'b'])
          expect(f.attempts()[1].home).toBe(f.home('b'))
          expect(f.attempts()[0].input).toBe(f.attempts()[1].input)
        } finally {
          registration.release()
        }
      }
    )

    it('runs an independent chat recipe without migrating the original session account', async () => {
      const f = await recipes()
      const record = agentSessionRecordFixture()
      const account = record.accountHome
      const deps = structuredChatNamingDeps(
        () => f.store,
        {
          resolveWorkspace: async () => ({ path: f.root, executionHostId: 'local' }),
          resolveNamingEnvironment: async () => f.env,
          getAgentEnvResolvers: () => f.resolvers,
          workerTaskTitle: () => null,
          retitleOpenTab: () => {}
        },
        { warn: () => {}, error: () => {} }
      )
      expect(await deps.generate(record, 'Repair login', () => true)).toEqual({ name: 'fix-auth' })
      expect(f.attempts().map((a) => a.account)).toEqual(['a', 'b'])
      expect(record.accountHome).toBe(account)
      expect(f.settings.activeClaudeManagedAccountId).toBe('a')
    })

    it.each(['success', 'stop', 'replaced'] as const)(
      'keeps Jira connection ownership on %s during B preparation',
      async (action) => {
        const f = await recipes()
        const ready = Promise.withResolvers<void>()
        const gate = Promise.withResolvers<void>()
        const original = f.auth.prepareAccountFolder
        const preparing = vi
          .spyOn(f.auth, 'prepareAccountFolder')
          .mockImplementation(async (id) => {
            if (id === 'b') {
              ready.resolve()
              await gate.promise
            }
            return original(id)
          })
        const host = { getSettings: () => f.settings, getAgentEnvironment: () => f.resolvers }
        const args = {
          siteId: 'site',
          draftId: 'draft',
          requestId: 'old',
          description: 'Repair login'
        }
        const pending = generateJiraIssueSummaryRequest(host, 'connection-owner', args)
        await ready.promise
        if (action === 'stop') {
          cancelJiraIssueSummaryRequest('connection-owner', args)
        }
        let newer: ReturnType<typeof generateJiraIssueSummaryRequest> | undefined
        if (action === 'replaced') {
          newer = generateJiraIssueSummaryRequest(host, 'connection-owner', {
            ...args,
            requestId: 'new'
          })
        }
        gate.resolve()
        expect(await pending).toMatchObject(
          action === 'success'
            ? { success: true, summary: 'fix-auth' }
            : { success: false, canceled: true }
        )
        if (newer) {
          expect(await newer).toMatchObject({ success: true, summary: 'fix-auth' })
        }
        await Promise.all(preparing.mock.results.map((r) => r.value))
        expect(f.attempts().filter((a) => a.account === 'b')).toHaveLength(
          action === 'stop' ? 0 : 1
        )
      }
    )

    it.each(['stop', 'host-switch', 'deleted'] as const)(
      'fences independent chat %s during B preparation',
      async (action) => {
        const f = await recipes()
        const ready = Promise.withResolvers<void>()
        const gate = Promise.withResolvers<void>()
        let owned = true
        let path = f.root
        let deleted = false
        const original = f.auth.prepareAccountFolder
        const preparing = vi
          .spyOn(f.auth, 'prepareAccountFolder')
          .mockImplementation(async (id) => {
            if (id === 'b') {
              ready.resolve()
              await gate.promise
            }
            return original(id)
          })
        const deps = structuredChatNamingDeps(
          () => f.store,
          {
            resolveWorkspace: async () => {
              if (deleted) {
                throw new Error('deleted')
              }
              return { path, executionHostId: 'local' }
            },
            resolveNamingEnvironment: async () => f.env,
            getAgentEnvResolvers: () => f.resolvers,
            workerTaskTitle: () => null,
            retitleOpenTab: () => {}
          },
          { warn: () => {}, error: () => {} }
        )
        const pending = deps.generate(agentSessionRecordFixture(), 'Repair login', () => owned)
        await ready.promise
        if (action === 'host-switch') {
          path = '/another-host'
        } else if (action === 'deleted') {
          deleted = true
        } else {
          owned = false
        }
        gate.resolve()
        expect(await pending).toBeNull()
        await Promise.all(preparing.mock.results.map((r) => r.value))
        expect(f.attempts().map((a) => a.account)).toEqual(['a'])
      }
    )
  }
)

describe.skipIf(process.platform === 'win32')('late alternate-account text results', () => {
  it.each(
    (['commit-message', 'pull-request-fields'] as const).flatMap((operation) =>
      (['edit', 'newer', 'stop'] as const).map((action) => ({
        operation,
        action
      }))
    )
  )(
    'keeps exact $operation request ownership after B has spawned on $action',
    async ({ operation, action }) => {
      const f = await fixture({ behavior: { a: 'quota', b: 'held-success' } })
      f.request.finish()
      const registration = beginLocalGenerationRequest(operation, {
        owner: 'original-owner',
        generationId: action
      })!
      registration.bindTarget({ cwd: f.root })
      const gate = join(f.root, 'release')
      let owned = true
      const target = sourceControlSubscriptionTarget(
        {
          kind: 'local',
          cwd: f.root,
          env: { ...f.env, ORCA_TEST_SUBSCRIPTIONS_GATE: gate },
          generationRequest: registration
        },
        f.params,
        { prepareTextSubscriptionFailover: f.prepare },
        async () => owned
      )
      const ready = Promise.withResolvers<void>()
      const pending = currentRunner({
        params: f.params,
        prompt: 'original immutable draft',
        target,
        operation,
        spawnAgent: (args) => {
          const child = spawnSourceControlAgent(args)
          child.stderr?.on('data', (chunk: Buffer) => {
            if (chunk.toString().includes('ORCA_TEST_SUBSCRIPTIONS_HELD_READY')) {
              ready.resolve()
            }
          })
          return child
        }
      })
      let newer: ReturnType<typeof beginLocalGenerationRequest> = undefined
      try {
        await ready.promise
        if (action === 'stop') {
          registration.cancelForTarget({ cwd: f.root })
        } else if (action === 'newer') {
          newer = beginLocalGenerationRequest(operation, {
            owner: 'original-owner',
            generationId: 'successor'
          })
          newer!.bindTarget({ cwd: f.root })
          newer!.startBudget({ cwd: f.root })
        } else {
          owned = false
        }
        writeFileSync(gate, '')
        expect(await pending).toMatchObject(
          action === 'newer' ? { success: true } : { success: false, canceled: true }
        )
        expect(f.attempts().map((a) => a.account)).toEqual(['a', 'b'])
        expect(newer?.canceled ?? false).toBe(false)
      } finally {
        writeFileSync(gate, '')
        await pending
        registration.release()
        newer?.release()
      }
    }
  )
})

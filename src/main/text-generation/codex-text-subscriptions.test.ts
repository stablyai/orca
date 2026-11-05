import { captureCodexProjectConfiguration } from './codex-project-configuration'
import { runProcessSync } from '@orca/process-host'
import * as hookHashLookup from '../codex/trust/hooks/codex-hook-hash-lookup'
import { CodexHookService } from '../codex/hooks/installation/codex-hook-service-implementation'
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type * as NodeOs from 'node:os'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import {
  createCodexAccountRecord,
  createManagedAuth,
  createCodexAuthJson,
  createStore,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from '../codex-accounts/runtime-home-service-test-harness'
import { createSettings } from '../codex-accounts/runtime-home-settings-test-fixtures'
import { createCodexTextSubscriptionPreparation } from './codex-text-subscriptions'
import { prepareLocalCommitMessageAgentEnv } from './commit-message-agent-environment'
import { fetchCodexRateLimits } from '../rate-limits/codex-fetcher'
import { setMainHttpClient } from '../network/http-client'
import { beginTextGenerationRequest } from './source-control-generation-lanes'
import { runGenerationRequest } from './agent-generation-request'
import { spawnSourceControlAgent } from './source-control-agent-launch'
import { RateLimitService } from '../rate-limits/service'
import {
  withCodexHomeProcessLock,
  resolveCodexHomeProcessLockKey
} from '../codex-cli/codex-home-process-lock'

vi.mock('../worker-thread-child-process/worker-thread-child-process', async () => ({
  spawnProcessOnWorkerThread: (await import('@orca/process-host')).spawnProcess
}))
vi.mock('node:os', async () => ({
  ...(await vi.importActual<typeof NodeOs>('node:os')),
  homedir: () => testState.fakeHomeDir
}))
vi.mock('../codex/codex-account-session-bridge', () => ({
  startCodexAccountSessionBridgeInBackground: () => {}
}))
vi.mock('../network/proxy-settings', () => ({ ensureElectronProxyFromEnvironment: async () => {} }))
beforeEach(() => {
  setupRuntimeHomeTest()
  installFakeAppEnvironment({ getPath: () => testState.userDataDir })
})
afterEach(() => {
  teardownRuntimeHomeTest()
  vi.restoreAllMocks()
})

async function fixture(
  options: { cold?: boolean; version?: string; afterInitialAttempt?: (cwd: string) => void } = {}
) {
  const root = testState.userDataDir
  const accounts = ['a', 'b'].map((id) =>
    createCodexAccountRecord(
      id,
      `${id}@example.test`,
      `acct-${id}`,
      createManagedAuth(
        root,
        id,
        createCodexAuthJson(`${id}@example.test`, `acct-${id}`, `fake-refresh-${id}`)
      )
    )
  )
  const settings = createSettings({
    realHomeRoutable: true,
    codexManagedAccounts: accounts,
    activeCodexManagedAccountId: 'a',
    textGenerationSubscriptionFailoverEnabled: true
  })
  const store = createStore(settings)
  const { CodexRuntimeHomeService } = await import('../codex-accounts/runtime-home-service')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime-home fixture implements the store operations exercised by this service.
  const home = new CodexRuntimeHomeService(store as never)
  store.updateSettings.mockClear()
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(
    join(bin, 'codex'),
    `#!${process.execPath}\n${readFileSync(join(import.meta.dirname, '__fixtures__/codex-subscription-cli.cjs'), 'utf8')}`,
    { mode: 0o755 }
  )
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
  setMainHttpClient({
    proxySession: () => null,
    fetch: async () => new Response('{}', { status: 404 })
  })
  const usage = options.cold
    ? accounts.map(() => ({
        provider: 'codex' as const,
        status: 'idle' as const,
        session: null,
        weekly: null,
        updatedAt: 0,
        error: null
      }))
    : await Promise.all(
        accounts.map((a) => fetchCodexRateLimits({ codexHomePath: a.managedHomePath }))
      )
  if (!options.cold) {
    expect(usage.map((value) => value.status)).toEqual(['ok', 'ok'])
  }
  const refresh = vi.fn(async () => {
    const fresh = await Promise.all(
      accounts.map((a) => fetchCodexRateLimits({ codexHomePath: a.managedHomePath }))
    )
    usage.splice(0, usage.length, ...fresh)
  })
  const state = new RateLimitService().getState()
  const rateLimits = {
    refreshTextSubscriptionAccounts: refresh,
    getState: () => ({
      ...state,
      codex: usage[0],
      inactiveCodexAccounts: [
        // ast-grep-ignore: test-no-wall-clock -- production judges usage freshness against the real clock
        { accountId: 'b', rateLimits: usage[1], updatedAt: Date.now(), isFetching: false }
      ]
    })
  }
  const request = beginTextGenerationRequest('branch-name', root, 60000, () => true)
  const log = join(root, 'attempts.jsonl')
  writeFileSync(log, '')
  const baseEnv = {
    PATH: process.env.PATH ?? '',
    ORCA_TEST_SUBSCRIPTIONS_LOG: log,
    ORCA_TEST_QUOTA_FIXTURE: join(
      import.meta.dirname,
      '__fixtures__/codex-0.166.0-quota-refusal.jsonl'
    ),
    ...(options.version ? { ORCA_TEST_CODEX_VERSION: options.version } : {})
  }
  const prepared = await prepareLocalCommitMessageAgentEnv('codex', {
    resolveBaseEnvironment: async () => baseEnv,
    prepareForCodexLaunch: (target) => home.prepareForCodexLaunch(target)
  })
  if (!prepared.ok || !prepared.env) {
    throw new Error('Managed Codex environment was not prepared')
  }
  const env = prepared.env
  const hookStatus = await new CodexHookService().install(accounts[0].managedHomePath, false)
  expect(hookStatus.managedHooksPresent).toBe(true)
  const params = { agentId: 'codex' as const, model: 'gpt-5.6-terra', thinkingLevel: 'low' }
  const subscription = createCodexTextSubscriptionPreparation({ store, home, rateLimits })({
    params,
    cwd: root,
    env,
    request
  })
  const run = async () => {
    try {
      return await runGenerationRequest({
        params,
        prompt: 'Name this fixed context',
        target: { kind: 'local', cwd: root, env, request, subscription },
        operation: 'branch-name',
        spawnAgent: (input) => {
          const child = spawnSourceControlAgent(input)
          if (
            input.args.includes('exec') &&
            input.env?.CODEX_HOME === accounts[0].managedHomePath
          ) {
            child.once('close', () => options.afterInitialAttempt?.(root))
          }
          return child
        }
      })
    } finally {
      request.finish()
    }
  }
  return {
    root,
    store,
    request,
    accounts,
    subscription,
    run,
    usage,
    refresh,
    attempts: () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
  }
}

describe.skipIf(process.platform === 'win32')(
  'managed Codex text subscription subprocess delivery',
  () => {
    it('uses B after a settled quota refusal from A and leaves global selection untouched', async () => {
      const f = await fixture()
      const hookLookup = vi.spyOn(hookHashLookup, 'resolveCodexHookAnswerForLaunch')
      const result = await f.run()
      const attempts = f.attempts()
      expect(attempts.map((a) => a.account)).toEqual(['a', 'b'])
      expect(result).toMatchObject({ success: true, rawOutput: 'fix-auth' })
      expect(attempts[1].home).toBe(f.accounts[1].managedHomePath)
      expect(readFileSync(join(f.accounts[1].managedHomePath, 'hooks.json'), 'utf8')).toContain(
        'codex-hook'
      )
      expect(readFileSync(join(f.accounts[1].managedHomePath, 'config.toml'), 'utf8')).toContain(
        ':stop:0:0'
      )
      expect(attempts[0].input).toBe(attempts[1].input)
      expect(attempts[0].args).toEqual(attempts[1].args)
      expect(hookLookup).not.toHaveBeenCalled()
      expect(f.store.updateSettings).not.toHaveBeenCalled()
      expect(f.store.getSettings().activeCodexManagedAccountId).toBe('a')
    })
    it.each(['disabled', 'unknown-attribute', 'unknown-hash'] as const)(
      'preserves %s managed hook trust without launching the alternate account',
      async (change) => {
        const f = await fixture()
        const home = f.accounts[1].managedHomePath
        await new CodexHookService().install(home, false)
        const file = join(home, 'config.toml')
        const original = readFileSync(file, 'utf8')
        const edited =
          change === 'disabled'
            ? original.replace('enabled = true', 'enabled = false')
            : change === 'unknown-attribute'
              ? original.replace('enabled = true', 'enabled = true\ncustom_flag = true')
              : original.replace(/trusted_hash = "[^"\n]+"/, 'trusted_hash = "unrecognized"')
        expect(edited).not.toBe(original)
        writeFileSync(file, edited)
        expect(await f.run()).toMatchObject({ success: false })
        expect(f.attempts().map((attempt) => attempt.account)).toEqual(['a'])
        expect(readFileSync(file, 'utf8')).toBe(edited)
      }
    )

    it.each(['policy', 'user-hook'] as const)(
      'keeps a differing %s configuration from executing an alternate attempt',
      async (change) => {
        const f = await fixture()
        const home = f.accounts[1].managedHomePath
        if (change === 'policy') {
          writeFileSync(join(home, 'config.toml'), 'approval_policy = "never"\n')
        } else {
          writeFileSync(
            join(home, 'hooks.json'),
            JSON.stringify({
              hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-owned-hook' }] }] }
            })
          )
        }
        expect(await f.run()).toMatchObject({ success: false })
        expect(f.attempts().map((attempt) => attempt.account)).toEqual(['a'])
        expect(
          readFileSync(join(home, change === 'policy' ? 'config.toml' : 'hooks.json'), 'utf8')
        ).toContain(change === 'policy' ? 'approval_policy = "never"' : 'user-owned-hook')
      }
    )

    it.each(['config.toml', 'hooks.json'] as const)(
      'does not replay after project %s is created when the real A process closes',
      async (file) => {
        const f = await fixture({
          afterInitialAttempt: (cwd) => {
            mkdirSync(join(cwd, '.codex'), { recursive: true })
            writeFileSync(
              join(cwd, '.codex', file),
              file === 'config.toml'
                ? '[mcp_servers.new_tool]\ncommand = "new-tool"\n'
                : '{"hooks":{}}'
            )
          }
        })
        expect(await f.run()).toMatchObject({ success: false })
        expect(f.attempts().map((attempt) => attempt.account)).toEqual(['a'])
      }
    )

    it.each(['project_root_markers = []', '[mcp_servers.custom]\ncommand = "custom-tool"'])(
      'retains ordinary execution for unsupported managed policy %s',
      async (policy) => {
        const f = await fixture()
        const file = join(f.accounts[0].managedHomePath, 'config.toml')
        writeFileSync(file, `${policy}\n${readFileSync(file, 'utf8')}`)
        expect(await f.run()).toMatchObject({ success: false })
        expect(f.attempts().map((attempt) => attempt.account)).toEqual(['a'])
        expect(f.attempts()[0].args).not.toContain('--json')
        expect(readFileSync(file, 'utf8')).toContain(policy)
      }
    )

    it('tracks real linked-worktree root-checkout inputs from nested cwd', async () => {
      const f = await fixture()
      const main = join(f.root, 'main')
      const linked = join(f.root, 'linked')
      mkdirSync(main)
      const git = (args: string[]) => {
        const result = runProcessSync({ program: 'git', args, cwd: main })
        expect(result.code, result.stderr).toBe(0)
      }
      git(['init'])
      git([
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '--allow-empty',
        '-m',
        'initial'
      ])
      git(['worktree', 'add', '--detach', linked])
      const nested = join(linked, 'nested')
      mkdirSync(nested)
      const project = captureCodexProjectConfiguration(nested, process.env)
      expect(await project.revalidate()).toBe(true)
      const admin = readFileSync(join(linked, '.git'), 'utf8')
        .trim()
        .replace(/^gitdir: /, '')
      writeFileSync(join(admin, 'unrelated-lock'), '')
      expect(await project.revalidate()).toBe(true)
      mkdirSync(join(main, 'nested', '.codex'), { recursive: true })
      writeFileSync(join(main, 'nested', '.codex', 'hooks.json'), '{"hooks":{}}')
      expect(await project.revalidate()).toBe(false)
      expect(project.current()).toBe(false)
      expect(await captureCodexProjectConfiguration(nested, process.env).revalidate()).toBe(false)
    })

    it('scans only cwd for a nongit folder and detects project policy creation', async () => {
      const f = await fixture()
      const folder = join(f.root, 'folder')
      mkdirSync(folder)
      mkdirSync(join(f.root, '.codex'))
      writeFileSync(join(f.root, '.codex', 'config.toml'), 'model = "outside-project"')
      const project = captureCodexProjectConfiguration(folder, process.env)
      expect(await project.revalidate()).toBe(true)
      mkdirSync(join(folder, '.codex'))
      writeFileSync(join(folder, '.codex', 'config.toml'), 'model = "inside-project"')
      // The hot-path fence stays cheap; the next attempt boundary observes the change and sticks.
      expect(project.current()).toBe(true)
      expect(await project.revalidate()).toBe(false)
      expect(project.current()).toBe(false)
      rmSync(join(folder, '.codex'), { recursive: true })
      expect(await project.revalidate()).toBe(false)
    })

    it.each([
      ['codex-cli 0.170.1', ['a', 'b']],
      ['codex-cli 0.165.9', ['a']]
    ] as const)('gates recovery on minimum CLI version for %s', async (version, accounts) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const f = await fixture({ version })
      expect(await f.run()).toMatchObject({ success: accounts.length === 2 })
      expect(f.attempts().map((a) => a.account)).toEqual(accounts)
    })
    it('continues after a same-account auth refresh but keeps quota evidence revision-bound', async () => {
      const f = await fixture()
      try {
        const attempt = (await f.subscription!.prepare('a'))!
        expect(attempt).not.toBeNull()
        const auth = join(f.accounts[0].managedHomePath, 'auth.json')
        writeFileSync(auth, createCodexAuthJson('a@example.test', 'acct-a', 'rotated-refresh-a'))
        expect(await attempt.valid()).toBe(true)
        expect(attempt.spawnAllowed?.()).toBe(true)
        // A 100% receipt observed under the old auth.json is re-observed before it counts.
        expect(await f.subscription!.confirmQuota!(attempt)).toBe(true)
        expect(f.refresh).toHaveBeenCalledTimes(1)
        writeFileSync(auth, createCodexAuthJson('a@example.test', 'acct-other', 'refresh-other'))
        expect(await attempt.valid()).toBe(false)
      } finally {
        f.request.finish()
      }
    })
    it('refreshes missing receipts and recovers in the original request', async () => {
      const f = await fixture({ cold: true })
      expect(await f.run()).toMatchObject({ success: true, rawOutput: 'fix-auth' })
      expect(f.attempts().map((a) => a.account)).toEqual(['a', 'b'])
      expect(f.refresh).toHaveBeenCalledTimes(1)
    })
    it('does not spawn when Stop arrives while the initial account lock is held', async () => {
      const f = await fixture()
      let entered!: () => void
      let release!: () => void
      const enteredLock = new Promise<void>((resolve) => {
        entered = resolve
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const lock = withCodexHomeProcessLock(
        resolveCodexHomeProcessLockKey(f.accounts[0].managedHomePath),
        async () => {
          entered()
          await gate
        }
      )
      await enteredLock
      const pending = f.run()
      f.request.cancel()
      release()
      await lock
      expect(await pending).toMatchObject({ success: false, canceled: true })
      expect(f.attempts()).toEqual([])
    })
    it('rejects stale usage rather than treating reset windows as empty', async () => {
      const f = await fixture()
      // ast-grep-ignore: test-no-wall-clock -- a reset already passed by the real clock makes usage stale
      f.usage[1].session!.resetsAt = Date.now() - 1
      f.refresh.mockResolvedValue(undefined)
      expect(await f.run()).toMatchObject({ success: false, subscriptionQuotaRefused: true })
      expect(f.attempts().map((a) => a.account)).toEqual(['a'])
    })
  }
)

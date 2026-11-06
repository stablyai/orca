import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import { agentSessionRecordFixture } from '../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import {
  createManagedHome,
  createRateLimits,
  createRuntimeHome,
  createSettings,
  createStore,
  registerCodexAccountsTestHomes,
  testState
} from './service-test-harness'
import {
  createResetCreditLimits,
  createResetRateLimitState
} from './service-reset-credit-test-fixtures'

const stubScript = { path: '' }
vi.mock('electron', () => ({ app: { getPath: () => testState.userDataDir } }))
vi.mock(import('node:os'), async (original) => ({
  ...(await original()),
  homedir: () => testState.fakeHomeDir
}))
beforeEach(() => installFakeAppEnvironment({ getPath: () => testState.userDataDir }))

describe('chat reset offer through the account coordinator', () => {
  registerCodexAccountsTestHomes()
  it('accepts the host-built offer and rejects a later stale offer without spending a credit', async () => {
    const { sessionAccountUsageOffer } =
      await import('../runtime/rpc/methods/structured-agent-session-account-usage')
    const { readCodexSessionAccountUsage } =
      await import('../codex/structured/session-lifecycle/codex-session-account-usage')
    stubScript.path = join(testState.userDataDir, 'chat-usage-cli.cjs')
    writeFileSync(
      stubScript.path,
      `
      let buffer = ''
      process.stdin.on('data', (chunk) => {
        buffer += chunk
        let at
        while ((at = buffer.indexOf('\\n')) !== -1) {
          const request = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1)
          if (request.id === undefined) continue
          const result = request.method === 'account/read' ? { account: { type: 'chatgpt', email: process.env.CODEX_HOME } }
            : request.method === 'account/rateLimits/read' ? { rateLimits: { primary: { usedPercent: 17, windowDurationMins: 300 } } } : {}
          process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n')
        }
      })
    `
    )
    const home = createManagedHome(testState.userDataDir, 'chat-account')
    const account = {
      id: 'chat-account',
      email: 'chat@example.com',
      managedHomePath: home,
      createdAt: 1,
      updatedAt: 2,
      lastAuthenticatedAt: 1
    }
    const settings = createSettings({
      codexManagedAccounts: [account],
      activeCodexManagedAccountId: account.id
    })
    let state = createResetRateLimitState(createResetCreditLimits(100))
    const consume = vi.fn(async () => ({ outcome: 'reset' as const, state }))
    const rateLimits = {
      ...createRateLimits(),
      getState: () => state,
      consumeCodexRateLimitResetCredit: consume
    }
    const { CodexAccountService } = await import('./service')
    const service = new CodexAccountService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the coordinator needs only the settings and durable-ledger methods this store implements.
      createStore(settings) as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture implements service snapshot reads and the provider consume boundary.
      rateLimits as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the runtime-home harness implements the account synchronization methods used here.
      createRuntimeHome() as never
    )
    const record = {
      ...agentSessionRecordFixture(),
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: home }
    }
    // A chat at rest reads its pinned home through the chat's own configured Codex command.
    const usage = await readCodexSessionAccountUsage(new Map(), () => ({
      resolveLaunchArgs: () => [],
      resolveWorkspacePath: async () => testState.userDataDir,
      resolveCommand: () => ({ command: process.execPath, prefixArgs: [stubScript.path] })
    }))(record, new AbortController().signal)
    expect(usage).toMatchObject({
      account: { email: home },
      rateLimits: { status: 'ok', session: { usedPercent: 17 } }
    })
    const offer = sessionAccountUsageOffer(record, settings, state).reset!
    state = createResetRateLimitState(createResetCreditLimits(101))
    await expect(
      service.consumeRateLimitResetCredit(
        '4f1ce0d3-1db5-438d-83c7-1f8c54006a4f',
        offer.expectedScope
      )
    ).resolves.toMatchObject({ status: 'rejectedBeforeProvider', reason: 'offerChanged' })
    expect(consume).not.toHaveBeenCalled()
    const refreshed = sessionAccountUsageOffer(record, settings, state).reset!
    await expect(
      service.consumeRateLimitResetCredit(
        '5b366530-7db1-4b1b-8bd3-b98832cb53c5',
        refreshed.expectedScope
      )
    ).resolves.toMatchObject({ outcome: 'reset', scope: refreshed.expectedScope })
    expect(consume).toHaveBeenCalledWith({
      idempotencyKey: '5b366530-7db1-4b1b-8bd3-b98832cb53c5',
      codexHomePath: home,
      target: { runtime: 'host', wslDistro: null }
    })
    expect(consume).toHaveBeenCalledTimes(1)
  })
})

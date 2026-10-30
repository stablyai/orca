import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../core'
import { ACCOUNT_METHODS } from './accounts'
import type {
  HostAccountSignInChannel,
  HostAccountSignInStatus
} from '../../../../shared/host-account-sign-in-types'

function method(name: string) {
  const found = eraseRpcMethods(ACCOUNT_METHODS).find((candidate) => candidate.name === name)
  if (!found) {
    throw new Error(`Missing method ${name}`)
  }
  return found
}

describe('account RPC methods', () => {
  it.each([
    {
      methodName: 'accounts.addCodexFromHome',
      params: { sourceHome: join(tmpdir(), 'codex-login') },
      runtimeMethod: 'addCodexAccountFromHome',
      expectedSource: join(tmpdir(), 'codex-login'),
      expectedOptions: { runtime: undefined, wslDistro: null }
    }
  ])('allows local-socket $methodName calls', async (testCase) => {
    const add = vi.fn().mockResolvedValue({ accounts: [] })
    const runtime = { [testCase.runtimeMethod]: add } as unknown as OrcaRuntimeService
    const addMethod = method(testCase.methodName)
    if (isStreamingMethod(addMethod)) {
      throw new Error(`${testCase.methodName} must be a request method`)
    }

    await addMethod.handler(testCase.params, { runtime })

    expect(add).toHaveBeenCalledWith(testCase.expectedSource, testCase.expectedOptions)
  })

  it.each([
    ['accounts.addCodexFromHome', { sourceHome: join(tmpdir(), 'codex-login') }, /only available/],
    [
      'accounts.addDataFromHome',
      { provider: 'opencode', sourceDataHome: join(tmpdir(), 'login'), label: 'Work' },
      /only available/
    ],
    ['accounts.beginClaudeSignIn', {}, /Sign in on the Orca execution host/],
    ['accounts.finishClaudeSignIn', { accountId: 'a' }, /Sign in on the Orca execution host/]
  ] as const)('rejects paired-device calls to %s', async (methodName, params, refusal) => {
    const runtime = {
      addCodexAccountFromHome: vi.fn(),
      addDataAccountFromHome: vi.fn(),
      beginClaudeSignIn: vi.fn(),
      finishClaudeSignIn: vi.fn()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: refused calls never reach the runtime; only these stubs are asserted.
    const runtimeService = runtime as unknown as OrcaRuntimeService
    const addMethod = method(methodName)
    if (isStreamingMethod(addMethod)) {
      throw new Error(`${methodName} must be a request method`)
    }

    for (const clientKind of ['mobile', 'runtime'] as const) {
      await expect(
        addMethod.handler(params, { runtime: runtimeService, clientKind })
      ).rejects.toThrow(refusal)
    }
    expect(runtime.addCodexAccountFromHome).not.toHaveBeenCalled()
    expect(runtime.addDataAccountFromHome).not.toHaveBeenCalled()
    expect(runtime.beginClaudeSignIn).not.toHaveBeenCalled()
    expect(runtime.finishClaudeSignIn).not.toHaveBeenCalled()
  })

  // Windows hosts refuse these sign-ins; HostAccountSignInFlows covers that refusal.
  it.skipIf(process.platform === 'win32')(
    'runs a paired client’s Claude sign-in on this host and relays its code (#20009)',
    async () => {
      let received: HostAccountSignInChannel | null = null
      const claudeState = { accounts: [], activeAccountId: null }
      const runHostAccountSignIn = vi.fn(
        async (_provider: string, channel: HostAccountSignInChannel) => {
          received = channel
          channel.onPrompt({
            url: 'https://claude.com/x?code=true',
            userCode: null,
            needsCode: true
          })
          expect(await channel.nextCode()).toBe('pasted-code')
          return { claude: claudeState }
        }
      )
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sign-in methods call only this runtime member.
      const runtime = { runHostAccountSignIn } as unknown as OrcaRuntimeService
      const device = {
        runtime,
        clientKind: 'runtime' as const,
        caller: { kind: 'paired-device' as const, deviceId: 'laptop' }
      }
      const call = async (
        name: string,
        params: unknown,
        ctx: Pick<RpcContext, 'caller' | 'clientKind'> = device
      ) => {
        const found = method(name)
        if (isStreamingMethod(found)) {
          throw new Error(`${name} must be a request method`)
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every host sign-in method answers with a HostAccountSignInStatus.
        return (await found.handler(found.params ? found.params.parse(params) : params, {
          runtime,
          ...ctx
        })) as HostAccountSignInStatus
      }

      const started = await call('accounts.hostSignInStart', { provider: 'claude' })
      const waiting = await call('accounts.hostSignInWait', { flowId: started.flowId })
      expect(waiting).toMatchObject({ phase: 'waiting', prompt: { needsCode: true } })
      await expect(
        call(
          'accounts.hostSignInSubmitCode',
          { flowId: started.flowId, code: 'x' },
          { ...device, caller: { kind: 'paired-device', deviceId: 'intruder' } }
        )
      ).rejects.toThrow('no longer active')
      await call('accounts.hostSignInSubmitCode', { flowId: started.flowId, code: ' pasted-code ' })
      await vi.waitFor(async () =>
        expect(
          await call('accounts.hostSignInWait', {
            flowId: started.flowId,
            afterRevision: waiting.revision
          })
        ).toMatchObject({ phase: 'signedIn', claude: claudeState })
      )
      expect(runHostAccountSignIn).toHaveBeenCalledWith('claude', received)
    }
  )

  it('refuses a host sign-in to a transport that cannot name its caller', async () => {
    const start = method('accounts.hostSignInStart')
    if (isStreamingMethod(start)) {
      throw new Error('accounts.hostSignInStart must be a request method')
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the refusal happens before any runtime member is read.
    const runtime = {} as unknown as OrcaRuntimeService
    await expect(
      start.handler({ provider: 'codex' }, { runtime, clientKind: 'runtime' })
    ).rejects.toThrow('cannot add accounts')
  })

  it('keeps explicit account-list refreshes on the forced refresh lane', async () => {
    const snapshot = { claude: null, codex: null }
    const runtime = {
      refreshAccountsForMobile: vi.fn().mockResolvedValue(undefined),
      getAccountsSnapshot: vi.fn(() => snapshot)
    } as unknown as OrcaRuntimeService
    const list = method('accounts.list')
    if (isStreamingMethod(list)) {
      throw new Error('accounts.list must be a request method')
    }

    // Omitted params from mobile/web must retain forced refresh.
    await expect(list.handler(list.params?.parse({}), { runtime })).resolves.toBe(snapshot)
    expect(runtime.refreshAccountsForMobile).toHaveBeenCalledOnce()
  })

  it('skips the forced provider refresh when the caller opts out', async () => {
    const snapshot = { claude: null, codex: null }
    const runtime = {
      refreshAccountsForMobile: vi.fn().mockResolvedValue(undefined),
      getAccountsSnapshot: vi.fn(() => snapshot)
    } as unknown as OrcaRuntimeService
    const list = method('accounts.list')
    if (isStreamingMethod(list)) {
      throw new Error('accounts.list must be a request method')
    }

    await expect(
      list.handler(list.params?.parse({ refreshUsage: false }), { runtime })
    ).resolves.toBe(snapshot)
    expect(runtime.refreshAccountsForMobile).not.toHaveBeenCalled()
  })

  it('forwards a client idempotency key when consuming a Codex reset credit', async () => {
    const idempotencyKey = '11111111-1111-4111-8111-111111111111'
    const expectedScope = {
      target: { runtime: 'host' as const, wslDistro: null },
      accountId: 'codex-account',
      accountRevision: 42,
      offerRevision: 'v1:offer'
    }
    const result = {
      outcome: 'reset',
      scope: expectedScope,
      snapshot: { claude: null, codex: null }
    }
    const consumeCodexRateLimitResetCredit = vi.fn().mockResolvedValue(result)
    const runtime = { consumeCodexRateLimitResetCredit } as unknown as OrcaRuntimeService
    const reset = method('accounts.consumeCodexResetCredit')
    if (isStreamingMethod(reset)) {
      throw new Error('accounts.consumeCodexResetCredit must be a request method')
    }

    expect(reset.params?.parse({ idempotencyKey, expectedScope })).toEqual({
      idempotencyKey,
      expectedScope
    })
    expect(() => reset.params?.parse({ idempotencyKey: 'not-a-uuid', expectedScope })).toThrow()
    expect(() =>
      reset.params?.parse({
        idempotencyKey,
        expectedScope: {
          ...expectedScope,
          target: { runtime: 'host', wslDistro: 'Ubuntu' }
        }
      })
    ).toThrow()
    expect(() =>
      reset.params?.parse({
        idempotencyKey,
        expectedScope: {
          ...expectedScope,
          target: { runtime: 'wsl', wslDistro: null }
        }
      })
    ).toThrow()
    expect(() => reset.params?.parse({ idempotencyKey, expectedScope, extra: true })).toThrow()
    await expect(reset.handler({ idempotencyKey, expectedScope }, { runtime })).resolves.toBe(
      result
    )
    expect(consumeCodexRateLimitResetCredit).toHaveBeenCalledWith(idempotencyKey, expectedScope)
  })

  it('forwards the exact WSL target when selecting a Codex account', async () => {
    const selectCodexAccountForTarget = vi
      .fn()
      .mockResolvedValue({ accounts: [], activeAccountId: null })
    const runtime = { selectCodexAccountForTarget } as unknown as OrcaRuntimeService
    const select = method('accounts.selectCodexForTarget')
    if (isStreamingMethod(select)) {
      throw new Error('accounts.selectCodexForTarget must be a request method')
    }
    const params = {
      accountId: null,
      target: { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }
    }

    expect(select.params?.parse(params)).toEqual(params)
    expect(
      select.params?.parse({
        accountId: null,
        target: { runtime: 'wsl', wslDistro: null }
      })
    ).toEqual({ accountId: null, target: { runtime: 'wsl', wslDistro: null } })
    expect(() =>
      select.params?.parse({
        accountId: null,
        target: { runtime: 'host', wslDistro: 'Ubuntu' }
      })
    ).toThrow()
    expect(() =>
      select.params?.parse({
        accountId: null,
        target: { runtime: 'wsl', wslDistro: '   ' }
      })
    ).toThrow()
    await expect(select.handler(params, { runtime })).resolves.toEqual({
      accounts: [],
      activeAccountId: null
    })
    expect(selectCodexAccountForTarget).toHaveBeenCalledWith(null, params.target)
  })

  it('uses a stale-aware refresh when a connection replays the subscription', async () => {
    const snapshot = { claude: null, codex: null }
    let cleanup: (() => void) | undefined
    const runtime = {
      getAccountsSnapshot: vi.fn(() => snapshot),
      onAccountsChanged: vi.fn(() => vi.fn()),
      registerSubscriptionCleanup: vi.fn((_id: string, nextCleanup: () => void) => {
        cleanup = nextCleanup
      }),
      refreshAccountsForMobile: vi.fn().mockResolvedValue(undefined),
      refreshAccountsForMobileSubscriber: vi.fn().mockResolvedValue(undefined)
    } as unknown as OrcaRuntimeService
    const subscribe = method('accounts.subscribe')
    if (!isStreamingMethod(subscribe)) {
      throw new Error('accounts.subscribe must be a streaming method')
    }
    const emit = vi.fn()

    const running = subscribe.handler(undefined, { runtime, connectionId: 'connection-1' }, emit)
    await vi.waitFor(() => {
      expect(runtime.refreshAccountsForMobileSubscriber).toHaveBeenCalledOnce()
    })

    expect(runtime.refreshAccountsForMobile).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'ready', snapshot }))
    cleanup?.()
    await running
  })
})

it('rejects the retired Claude import even for a local socket, before touching its supplied path', async () => {
  const old = method('accounts.addClaudeFromConfigDir')
  if (isStreamingMethod(old)) {
    throw new Error('Unexpected stream')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Rejection happens before the handler accesses its context.
  await expect(old.handler({ configDir: '/never-read' }, {} as never)).rejects.toThrow(
    'Update the Orca CLI to add accounts'
  )
})

it('takes a host launch env from the owning desktop and refuses a phone', async () => {
  const set = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler calls only this stub.
  const runtime = {
    setHostAccountLaunchEnv: set
  } as unknown as OrcaRuntimeService
  const setMethod = method('accounts.setHostLaunchEnv')
  if (isStreamingMethod(setMethod)) {
    throw new Error('accounts.setHostLaunchEnv must be a request method')
  }
  const params = {
    wslDistro: 'Ubuntu',
    claude: {},
    terminal: { CODEX_HOME: '/home/u/.codex-b' }
  }
  await setMethod.handler(params, { runtime, clientKind: 'runtime' })
  expect(set).toHaveBeenCalledWith(params)
  await expect(setMethod.handler(params, { runtime, clientKind: 'mobile' })).rejects.toThrow(
    /Only the Orca desktop/
  )
  expect(set).toHaveBeenCalledOnce()
})

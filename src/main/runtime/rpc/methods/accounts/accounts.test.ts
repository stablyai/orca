import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../../core'
import { ACCOUNT_METHODS } from './accounts'
import type {
  HostAccountSignInChannel,
  HostAccountSignInStatus
} from '../../../../../shared/host-account-sign-in-types'

function method(name: string) {
  const found = eraseRpcMethods(ACCOUNT_METHODS).find((candidate) => candidate.name === name)
  if (!found) {
    throw new Error(`Missing method ${name}`)
  }
  return found
}

describe('account RPC methods', () => {
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
})

import { expect, it, vi } from 'vitest'
import type { RpcContext } from '../../core'
import type { RpcCallerIdentity } from '../../callers/rpc-caller-identity'
import { BROWSER_PROFILE_METHODS } from './browser-profile-rpc-methods'

const CLEARS = ['browser.profileClearCookies', 'browser.profileClearDefaultCookies']

it("clears a profile's cookies for the person's Orca, never for an agent's CLI", async () => {
  const cases: [RpcCallerIdentity, boolean][] = [
    [{ kind: 'local-cli' }, false],
    [{ kind: 'paired-device', deviceId: 'server-agent', agent: true }, false],
    [{ kind: 'desktop' }, true],
    [{ kind: 'paired-device', deviceId: 'paired-desktop' }, true]
  ]
  for (const name of CLEARS) {
    const method = BROWSER_PROFILE_METHODS.find((entry) => entry.name === name)!
    for (const [caller, allowed] of cases) {
      const runtime = {
        browserProfileClearCookies: vi.fn(async () => ({ cleared: true })),
        browserProfileClearDefaultCookies: vi.fn(async () => ({ cleared: true }))
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these handlers only reach the two clear commands.
      const context = { runtime, caller } as unknown as RpcContext
      const params = { profileId: 'work', executorRuntimeId: 'server' }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both clear methods take these params.
      const handler = method.handler as (params: unknown, context: RpcContext) => Promise<unknown>
      if (allowed) {
        await expect(handler(params, context)).resolves.toEqual({ cleared: true })
      } else {
        await expect(handler(params, context)).rejects.toThrow("Agents can't clear")
        expect(runtime.browserProfileClearCookies).not.toHaveBeenCalled()
        expect(runtime.browserProfileClearDefaultCookies).not.toHaveBeenCalled()
      }
    }
  }
})

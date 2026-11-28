import { expect, it, vi } from 'vitest'
import type { RpcContext } from '../../core'
import type { RpcCallerIdentity } from '../../callers/rpc-caller-identity'
import { BROWSER_TAB_CDP_METHODS } from './browser-tab-cdp-rpc-method'

const method = BROWSER_TAB_CDP_METHODS.find((entry) => entry.name === 'browser.tabCdp')!
const ENDPOINT = {
  browserPageId: 'page-1',
  url: 'ws://127.0.0.1:4100/token',
  agentBrowser: '/orca/agent-browser'
}

it('hands the raw CDP endpoint only to the local orca CLI', async () => {
  const cases: [RpcCallerIdentity | undefined, boolean][] = [
    [{ kind: 'local-cli' }, true],
    [{ kind: 'paired-device', deviceId: 'server-agent', agent: true }, false],
    [{ kind: 'paired-device', deviceId: 'phone' }, false],
    [{ kind: 'desktop' }, false],
    [undefined, false]
  ]
  for (const [caller, allowed] of cases) {
    const runtime = { browserTabCdp: vi.fn(async () => ENDPOINT) }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler only reaches browserTabCdp.
    const context = { runtime, caller } as unknown as RpcContext
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: params are parsed by the schema below.
    const handler = method.handler as (params: unknown, context: RpcContext) => Promise<unknown>
    const params = method.params.parse({ page: 'page-1' })
    if (allowed) {
      await expect(handler(params, context)).resolves.toEqual(ENDPOINT)
      expect(runtime.browserTabCdp).toHaveBeenCalledWith({ page: 'page-1' })
    } else {
      await expect(handler(params, context)).rejects.toThrow('only to the local orca CLI')
      expect(runtime.browserTabCdp).not.toHaveBeenCalled()
    }
  }
})

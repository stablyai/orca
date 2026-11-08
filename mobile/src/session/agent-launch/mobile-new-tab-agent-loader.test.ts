import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import '../../../../src/shared/protocol-version'

import { loadMobileAgentLaunchContext, newTabAgentOptionsFrom } from './mobile-new-tab-agent-loader'

async function loadOptions(
  args: Parameters<typeof loadMobileAgentLaunchContext>[0]
): Promise<unknown[]> {
  const context = await loadMobileAgentLaunchContext(args)
  return newTabAgentOptionsFrom(context.settings, context.detectedAgents)
}

function createClient(
  handler: (method: string, params?: unknown) => Promise<unknown>
): RpcClient & { sendRequest: ReturnType<typeof vi.fn> } {
  return {
    sendRequest: vi.fn(handler),
    subscribe: vi.fn(() => () => {})
  } as unknown as RpcClient & { sendRequest: ReturnType<typeof vi.fn> }
}

describe('mobile new-tab agent loading', () => {
  it('does not fall back to probing locally when an older host refuses the folder catalog', async () => {
    const client = createClient(async (method) => {
      if (method === 'settings.get') {
        return { ok: true, result: { settings: {} } }
      }
      return { ok: false, error: { code: 'method_not_found', message: 'Unknown method' } }
    })
    await expect(loadOptions({ client, worktreeId: 'folder:fw-1' })).rejects.toThrow(
      'Unknown method'
    )
    expect(client.sendRequest.mock.calls.some(([method]) => method.startsWith('preflight.'))).toBe(
      false
    )
  })

  // Put another host’s colliding repo id first so its SSH connection cannot accidentally address this host.
})

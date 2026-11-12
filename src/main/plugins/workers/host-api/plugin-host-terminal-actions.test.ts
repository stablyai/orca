import { describe, expect, it, vi } from 'vitest'
import type { PluginRuntimeRpc } from './plugin-host-runtime-call'
import { callPluginHost, pluginHostTestServices } from './__mocks__/plugin-host-services-fixture'
import { executePluginHostCall } from './plugin-host-methods'
import { PluginHostCallError } from './plugin-host-call-scope'

const focusedOn = (terminalIds: string[]) => ({
  resolveActiveWorktreeContext: vi
    .fn()
    .mockResolvedValue({ worktreeId: 'repo::/w', branch: 'main', displayName: 'w' }),
  listWorktreeTerminals: vi.fn().mockResolvedValue(terminalIds.map((id) => ({ id })))
})

describe('terminal.close', () => {
  const close = (rpc: PluginRuntimeRpc, terminalId = 'term_a') =>
    callPluginHost({
      method: 'terminal.close',
      params: { terminalId },
      granted: ['terminal:send'],
      services: pluginHostTestServices(rpc, focusedOn(['term_a']))
    })

  it('gains no close rights from a create that finished after the plugin lost approval', async () => {
    let approved = true
    const rpc = vi.fn(async () => {
      // Approval is revoked while the runtime creates the terminal.
      approved = false
      return { terminal: { handle: 'term_late' } }
    })
    const created = await executePluginHostCall({
      pluginId: 'samples.demo',
      method: 'terminal.create',
      params: { workspaceId: 'identity:other' },
      surface: 'worker',
      grantedCapabilities: ['terminal:send'],
      services: pluginHostTestServices(rpc),
      audit: { record: vi.fn().mockResolvedValue(undefined) },
      scope: {
        assertActive: () => {
          if (!approved) {
            throw new PluginHostCallError('consent_required', 'plugin is no longer enabled')
          }
        }
      }
    })
    expect(created).toMatchObject({ ok: false, code: 'consent_required' })
    expect(await close(vi.fn(), 'term_late')).toMatchObject({ ok: false, code: 'action_failed' })
  })
})

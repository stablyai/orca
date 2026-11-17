import { afterEach, describe, expect, it } from 'vitest'
import type { ValidDiscoveredPlugin } from '../../../plugins/discovery/plugin-discovery'
import { setPluginHookRunner } from '../../../plugins/hooks/plugin-hook-dispatch'
import { createPluginHookRunner } from '../../../plugins/hooks/plugin-hook-participants'
import type { PluginWorkerHandle } from '../../../plugins/workers/parent-process/plugin-host-process-types'
import type * as z from 'zod'
import type { agentLaunchBeforeHookPayloadSchema } from '../../../../shared/plugins/events/plugin-hook-payloads'
import { applyAgentLaunchPluginHook } from './spawn-agent-launch-plugin-hook'

type AgentLaunchBeforePayload = z.infer<typeof agentLaunchBeforeHookPayloadSchema>

/** One installed plugin whose `agent.launch.before` handler chooses account `b`. */
function installAccountChooser(): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook runner reads only these fields of a discovered plugin.
  const plugin = {
    pluginKey: 'chooser',
    isDev: false,
    rootDir: '/plugins/chooser',
    consentFingerprint: 'chooser',
    manifest: { main: 'worker.js', contributes: { hooks: [{ event: 'agent.launch.before' }] } }
  } as never as ValidDiscoveredPlugin
  setPluginHookRunner(
    createPluginHookRunner({
      plugins: () => [plugin],
      isRuntimeApproved: () => true,
      isEnabled: () => true,
      logWarning: () => () => {},
      ensureWorker: async () =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook runner calls only runHook on a worker.
        ({
          runHook: async (_event: string, payload: AgentLaunchBeforePayload) => ({
            decision: 'continue',
            payload: { ...payload, accountId: 'b' }
          })
        }) as never as PluginWorkerHandle
    })
  )
}

afterEach(() => setPluginHookRunner(null))

describe('agent.launch.before accountId', () => {
  it('returns the account a plugin chose beside the args, never on them', async () => {
    installAccountChooser()
    const args = { launchAgent: 'claude' as const, command: 'claude', env: { KEEP: '1' } }
    await expect(applyAgentLaunchPluginHook(args, undefined)).resolves.toEqual({
      args,
      accountId: 'b'
    })
  })
})

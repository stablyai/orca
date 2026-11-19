import { expect, it } from 'vitest'
import { launchAgentInExistingWorkspace } from './mobile-existing-agent-launch'
import { historyClient, historySession } from '../../agent-history/mobile-history-test-fixture'
import { LogicalClientCutoverError } from '../../transport/connection/logical-client-cutover-error'
import { markRpcDeliveryUnknown } from '../../transport/rpc/rpc-delivery-ambiguity'

it.each(['cutover', 'lost-reply'])(
  'cancels a handoff before a %s resend after its view changes',
  async (failure) => {
    let current = true
    const client = historyClient(historySession(), async (method) => {
      if (method !== 'agent.launchReplay' || !current) {
        return
      }
      current = false
      throw failure === 'cutover'
        ? new LogicalClientCutoverError()
        : markRpcDeliveryUnknown(new Error('reply lost'))
    })
    await expect(
      launchAgentInExistingWorkspace({
        client,
        hostCapabilities: ['agent.launch.v2', 'agent.launch.replay-required.v1'],
        worktreeId: 'repo::/repo',
        agent: 'codex',
        prompt: { text: 'Continue', delivery: 'submit' },
        assertCurrentOwner: () => {
          if (!current) {
            throw new Error('view changed')
          }
        }
      })
    ).rejects.toThrow('view changed')
  }
)

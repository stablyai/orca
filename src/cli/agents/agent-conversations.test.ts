import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/types'
import { AGENT_CONVERSATION_HANDLERS } from './agent-conversations'

afterEach(() => {
  vi.restoreAllMocks()
})

it('tells the user to update a host that predates agent commands', async () => {
  const client = new RuntimeClient('/tmp/orca-agent-test', 60_000, null, null)
  vi.spyOn(client, 'call').mockRejectedValue(
    new RuntimeClientError('method_not_found', 'Unknown method: agent.read')
  )

  await expect(
    AGENT_CONVERSATION_HANDLERS['agent read']({
      flags: new Map([['id', 'orca_session_id:claude_5688af50_12a0_4b0b_9a4a_098d87fe1e68']]),
      client,
      cwd: '/tmp/worktree',
      json: true
    })
  ).rejects.toMatchObject({ code: 'incompatible_runtime' })
})

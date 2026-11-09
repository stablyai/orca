import { describe, expect, it } from 'vitest'
import '../../../orca-runtime-tests/runtime-test-module-registration.spec'
import { createRuntime } from '../../../orca-runtime-tests/orca-runtime-test-fixtures.spec'

const CHAT = 'orca_session_id:0f9c2f6e-6c1b-4f5e-9d8a-2b7f3c4d5e6f'

describe('terminal commands addressed to a chat', () => {
  it('refuses read and send as a chat session instead of a stale terminal handle', async () => {
    const runtime = createRuntime()
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const refusal = {
      code: 'terminal_unsupported_for_agent_session',
      message: expect.stringContaining(`orca orchestration send --to ${CHAT}`)
    }

    await expect(runtime.readTerminal(CHAT)).rejects.toMatchObject(refusal)
    await expect(
      runtime.sendTerminal(CHAT, { text: 'hi', enter: true }, { inputKind: 'driving' })
    ).rejects.toMatchObject(refusal)
  })
})

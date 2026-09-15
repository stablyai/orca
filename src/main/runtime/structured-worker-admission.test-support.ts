import { expect } from 'vitest'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { sendStructuredWorkerPreamble } from './rpc/methods/orchestration-structured-worker-session'

export async function expectStructuredWorkerAdmission(sessionId: string): Promise<void> {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    throw new Error('structured host missing')
  }
  const preamble = 'Complete the dispatched task once.'
  await expect(
    sendStructuredWorkerPreamble({
      host,
      sessionId,
      dispatchId: 'worker-admission',
      preamble
    })
  ).resolves.toBeUndefined()
  const snapshot = host.journalSnapshot(sessionId)
  expect(snapshot.submissions).toMatchObject([{ dispatchState: 'pending' }])
  expect(snapshot.items.filter((item) => item.body.kind === 'message')).toMatchObject([
    { body: { role: 'user', blocks: [{ type: 'text', text: preamble }] } }
  ])
}

import { afterEach, expect, it } from 'vitest'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { closeProviderTimelineRigs } from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  sendHello,
  waitFor
} from './testing/acp-structured-adapter.test-support'

const ANTIGRAVITY = acpLaunchSpecFor('antigravity')!
afterEach(closeProviderTimelineRigs)

// agy 1.5.12 frames a failed request as "\n⚠ %s\n" in its own chunk, then replies end_turn.
const UNAUTHENTICATED =
  '⚠ UNAUTHENTICATED (code 401): Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.'

const chunk = (text: string) => ({
  sessionId: PROVIDER_SESSION,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
})

it("fails the turn on agy's streamed 401 notice, shown as an error row and not as its reply", async () => {
  const rig = await openAcpAdapterRig({
    spec: ANTIGRAVITY,
    script: (agent) =>
      agent.on('session/prompt', (frame) => {
        agent.notify('session/update', chunk('The log said UNAUTHENTICATED (code 401).'))
        agent.notify('session/update', chunk(`\n${UNAUTHENTICATED}\n`))
        agent.reply(frame, { stopReason: 'end_turn' })
      })
  })
  await rig.acquire()
  await sendHello(rig, 'send-1')
  const rows = await waitFor(async () => {
    const found = await rig.rig.rows()
    expect(found.some((row) => readAgentJournalTurn(row.body)?.state === 'completed')).toBe(true)
    return found
  })
  expect(rows.map((row) => readAgentJournalTurn(row.body)?.outcome).filter(Boolean)).toEqual([
    'failure'
  ])
  expect(rows.filter((row) => row.body.kind !== 'turn').map((row) => row.body)).toEqual([
    {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'The log said UNAUTHENTICATED (code 401).' }]
    },
    { kind: 'status', tone: 'error', text: UNAUTHENTICATED }
  ])
})

// agy 1.5.13 on a rejected Gemini API key.
const KEY_REJECTED =
  '⚠ agent executor error: generating and executing: Error 400, Message: API key not valid. Please pass a valid API key., Status: INVALID_ARGUMENT, Details: [map[@type:type.googleapis.com/google.rpc.ErrorInfo domain:googleapis.com metadata:map[service:generativelanguage.googleapis.com] reason:API_KEY_INVALID]]'

it.each([KEY_REJECTED])("fails the turn on agy's executor error notice: %s", async (notice) => {
  const rig = await openAcpAdapterRig({
    spec: ANTIGRAVITY,
    script: (agent) =>
      agent.on('session/prompt', (frame) => {
        agent.notify('session/update', chunk(`\n${notice}\n`))
        agent.reply(frame, { stopReason: 'end_turn' })
      })
  })
  await rig.acquire()
  await sendHello(rig, 'send-1')
  const rows = await waitFor(async () => {
    const found = await rig.rig.rows()
    expect(found.some((row) => readAgentJournalTurn(row.body)?.state === 'completed')).toBe(true)
    return found
  })
  expect(rows.map((row) => readAgentJournalTurn(row.body)?.outcome).filter(Boolean)).toEqual([
    'failure'
  ])
  expect(rows.filter((row) => row.body.kind !== 'turn').map((row) => row.body)).toEqual([
    { kind: 'status', tone: 'error', text: notice }
  ])
})

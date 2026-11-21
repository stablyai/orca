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

it.each([
  'API key not valid. Please pass a valid API key.',
  'Agent execution error: failed to create Gemini client: failed to configure default GCP credentials for Vertex AI: credentials: could not find default credentials.'
])("fails the turn on the server's own credential notice: %s", async (notice) => {
  const rig = await openAcpAdapterRig({
    spec: ANTIGRAVITY,
    script: (agent) =>
      agent.on('session/prompt', (frame) => {
        agent.notify('session/update', chunk(notice))
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

// agy_acp_server drops a session whose agent it cannot rebuild; the Python error then reaches ACP
// as -32603 "Internal error" with its text in data.details.
it.each([
  `Session not found: ${PROVIDER_SESSION}`,
  'Failed to rebuild agent: Harness process exited with code 1.\nHarness stderr:\n(no stderr output)'
])(
  'retires a dropped Antigravity session so the next send starts a new one: %s',
  async (details) => {
    let generation = 0
    let prompts = 0
    const rig = await openAcpAdapterRig({
      spec: ANTIGRAVITY,
      deps: { mintGeneration: () => `gen-${++generation}` },
      script: (agent) =>
        agent.on('session/prompt', (frame) =>
          ++prompts === 1
            ? agent.fail(frame, -32603, 'Internal error', { details })
            : agent.reply(frame, { stopReason: 'end_turn' })
        )
    })
    await rig.acquire()
    await sendHello(rig, 'send-1')
    await waitFor(() => expect(rig.ended).toHaveLength(1))
    await rig.acquire({ fence: 2 })
    await sendHello(rig, 'send-2', 2)
    await waitFor(async () => {
      const outcomes = (await rig.rig.rows()).flatMap(
        (row) => readAgentJournalTurn(row.body)?.outcome ?? []
      )
      expect(outcomes).toEqual(['failure', 'success'])
    })
  }
)

it('keeps the Antigravity session when the missing session is another one', async () => {
  const rig = await openAcpAdapterRig({
    spec: ANTIGRAVITY,
    script: (agent) =>
      agent.on('session/prompt', (frame) =>
        agent.fail(frame, -32603, 'Internal error', { details: 'Session not found: other' })
      )
  })
  await rig.acquire()
  await sendHello(rig, 'send-1')
  await waitFor(async () => {
    const rows = await rig.rig.rows()
    expect(rows.some((row) => readAgentJournalTurn(row.body)?.outcome === 'failure')).toBe(true)
  })
  await sendHello(rig, 'send-2')
  await rig.frame('session/prompt', 1)
  expect(rig.ended).toEqual([])
})

// A harness that dies mid-turn and cannot be rebuilt: agy drops the session, streams this notice
// and ends the turn normally; every later prompt would find no session.
it.each([
  'Harness process exited with code 1.\nHarness stderr:\n(no stderr output)',
  'Failed to initialize conversation at /tmp/agy. Stderr: (none)'
])(
  'fails the turn and retires the session on agy streaming that it could not rebuild the agent: %s',
  async (reason) => {
    const notice = `Agent connection was lost and could not be re-established: Failed to rebuild agent: ${reason}`
    let generation = 0
    let prompts = 0
    const rig = await openAcpAdapterRig({
      spec: ANTIGRAVITY,
      deps: { mintGeneration: () => `gen-${++generation}` },
      script: (agent) =>
        agent.on('session/prompt', (frame) => {
          if (++prompts === 1) {
            agent.notify('session/update', chunk(notice))
          }
          agent.reply(frame, { stopReason: 'end_turn' })
        })
    })
    await rig.acquire()
    await sendHello(rig, 'send-1')
    await waitFor(() => expect(rig.ended).toHaveLength(1))
    const rows = await rig.rig.rows()
    expect(rows.filter((row) => row.body.kind !== 'turn').map((row) => row.body)).toEqual([
      { kind: 'status', tone: 'error', text: notice }
    ])
    await rig.acquire({ fence: 2 })
    await sendHello(rig, 'send-2', 2)
    await waitFor(async () => {
      const outcomes = (await rig.rig.rows()).flatMap(
        (row) => readAgentJournalTurn(row.body)?.outcome ?? []
      )
      expect(outcomes).toEqual(['failure', 'success'])
    })
  }
)

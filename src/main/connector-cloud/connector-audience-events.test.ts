import { expect, it } from 'vitest'
import {
  CONNECTOR_PATHS,
  type ConnectorPrompt
} from '../../shared/connectors/connector-cloud-contract'
import type { ConversationSnapshot } from '../external-conversations/external-conversation-events'
import {
  pollClientHarness,
  settle,
  SERVER_NOW,
  conversation
} from './connector-poll-client.test-fixture'
import { fakeSeam } from './fake-connector-seam.test-fixture'
import { ConnectorTurnEvents } from './connector-turn-events'

const h = pollClientHarness()
const pane = {
  conversation,
  paneKey: 'sample-pane',
  worktreeId: 'sample-workspace',
  sshHostId: null
}
const prompt: ConnectorPrompt = {
  kind: 'approval',
  promptId: 'private-prompt',
  tool: 'Private sample command',
  options: [{ id: 'allow', label: 'Allow' }],
  raisedBy: 'orca',
  open: { sessionId: 'sample-session', itemId: 'private-prompt' }
}
const snapshot: ConversationSnapshot = {
  kind: 'snapshot',
  conversations: [
    { ...pane, agent: 'codex', working: true, prompt, turnId: 500, activeAt: SERVER_NOW }
  ]
}
const wireSnapshot = (visiblePrompt: ConnectorPrompt | null) => ({
  kind: 'snapshot',
  conversations: [
    {
      conversation,
      paneKey: 'sample-pane',
      agent: 'codex',
      working: true,
      prompt: visiblePrompt,
      turnId: 500
    }
  ]
})

function privateSeam() {
  const seam = fakeSeam()
  const watch = seam.calls.watch.getMockImplementation()
  if (!watch) {
    throw new Error('missing seam watch')
  }
  seam.calls.watch.mockImplementation((host, listener) =>
    watch(host, (event) => listener(event.kind === 'snapshot' ? snapshot : event))
  )
  return seam
}

it('fences the first snapshot and later events when the hello accepts audience prompts', async () => {
  h.fake.features = ['prompts.audience']
  const seam = privateSeam()
  const { client } = h.startClient(seam)
  await settle()
  expect(h.fake.requestsTo(CONNECTOR_PATHS.events)[0]?.body).toEqual({
    v: 2,
    helloRev: 1,
    seq: 0,
    events: [wireSnapshot(prompt)]
  })
  seam.emit({ ...pane, kind: 'prompt', prompt })
  await settle()
  expect(h.fake.requestsTo(CONNECTOR_PATHS.events).at(-1)?.body).toEqual({
    v: 2,
    helloRev: 1,
    seq: 1,
    events: [{ conversation, paneKey: 'sample-pane', kind: 'prompt', prompt }]
  })
  client.stop()
})

it('filters private live and snapshot prompts from a legacy hello', async () => {
  const seam = privateSeam()
  const { client } = h.startClient(seam)
  await settle()
  seam.emit({ ...pane, kind: 'prompt', prompt })
  seam.emit({ ...pane, kind: 'turn-started', at: 900 })
  await settle()
  expect(h.fake.events).toEqual([
    wireSnapshot(null),
    { conversation, paneKey: 'sample-pane', kind: 'turn-started', at: 900 }
  ])
  expect(h.fake.requestsTo(CONNECTOR_PATHS.events).at(-1)?.body).toMatchObject({ v: 1 })
  client.stop()
})

it('keeps the stamped v2 body on retry when the current projection loses audience support', async () => {
  h.fake.features = ['prompts.audience']
  h.fake.forced.set(CONNECTOR_PATHS.events, { status: 503 })
  const events = new ConnectorTurnEvents(h.userDataPath, 'ada')
  const { client } = h.startClient(privateSeam(), events)
  await settle()
  events.useCloudFeatures(new Set(), 1)
  h.fake.forced.delete(CONNECTOR_PATHS.events)
  await settle(1500)
  expect(h.fake.requestsTo(CONNECTOR_PATHS.events).map((request) => request.body)).toEqual([
    { v: 2, helloRev: 1, seq: 0, events: [wireSnapshot(prompt)] },
    { v: 2, helloRev: 1, seq: 0, events: [wireSnapshot(prompt)] }
  ])
  client.stop()
})

it('backs off after a v2 rejection and rebuilds a filtered legacy snapshot without replaying the private batch', async () => {
  h.fake.features = ['prompts.audience']
  h.fake.forced.set(CONNECTOR_PATHS.events, { status: 400, body: { error: 'invalid_request' } })
  const { client } = h.startClient(privateSeam())
  await settle()
  const rejected = { v: 2, helloRev: 1, seq: 0, events: [wireSnapshot(prompt)] }
  expect(h.fake.requestsTo(CONNECTOR_PATHS.events).map((request) => request.body)).toEqual([
    rejected
  ])
  h.fake.features = []
  h.fake.forced.delete(CONNECTOR_PATHS.events)
  h.poll([], { control: { pausedForMs: 0 } })
  await settle(500)
  expect(h.fake.requestsTo(CONNECTOR_PATHS.events).map((request) => request.body)).toEqual([
    rejected
  ])
  await settle(10_000)
  expect(h.fake.requestsTo(CONNECTOR_PATHS.events).map((request) => request.body)).toEqual([
    rejected,
    { v: 1, helloRev: 2, seq: 0, events: [wireSnapshot(null)] }
  ])
  expect(h.fake.events).toEqual([wireSnapshot(null)])
  client.stop()
})

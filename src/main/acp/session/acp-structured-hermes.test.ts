import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { readAgentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import {
  agentJournalTurnBody,
  readAgentJournalTurn
} from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { structuredAgentSessionCommandTurn } from '../../../shared/agent-session/view/structured-agent-session-command-turn-identity'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { StructuredAgentRegistry } from '../../native-chat/agent-session-wire/providers/structured-agent-registry'
import { acpLaunchSpecFor } from '../launch/acp-launch-registry'
import { acpStructuredAgentDefinition } from './acp-structured-agent-definitions'
import {
  deferred,
  type AcpScriptedAgent,
  type FakeFrame
} from '../process/testing/acp-scripted-agent.test-support'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  sendHello,
  waitFor
} from './testing/acp-structured-adapter.test-support'
import { openHostRig, send } from './testing/acp-structured-host.test-support'
import { CALLER } from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-host.test-fixture'
import {
  HOST_TEST_SESSION as HOST_SESSION,
  hostTestAttachParams
} from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session/agent-session-wire'

const HERMES = acpLaunchSpecFor('hermes')!
afterEach(closeProviderTimelineRigs)

// Captured from Hermes 0.23.1: a command its approval policy flags, under the default manual mode.
const COMMAND_APPROVAL = {
  sessionId: PROVIDER_SESSION,
  toolCall: {
    toolCallId: 'perm-check-1',
    title: 'recursive delete: rm -rf /tmp/proj/zz',
    kind: 'execute',
    status: 'pending',
    rawInput: { command: 'rm -rf /tmp/proj/zz', description: 'recursive delete' },
    content: [
      {
        type: 'content',
        content: { type: 'text', text: 'recursive delete\n$ rm -rf /tmp/proj/zz' }
      }
    ]
  },
  options: [
    { kind: 'allow_once', name: 'Allow once', optionId: 'allow_once' },
    { kind: 'allow_always', name: 'Allow for session', optionId: 'allow_session' },
    { kind: 'allow_always', name: 'Allow always', optionId: 'allow_always' },
    { kind: 'reject_once', name: 'Deny', optionId: 'deny' },
    { kind: 'reject_always', name: 'Deny always', optionId: 'deny_always' }
  ]
}

const NOT_CONNECTED =
  '⚠️ Hermes is not connected to any AI provider yet. Run `hermes model` to pick one, type `/login` in chat, or add a key with `hermes auth add <provider>`.\n\nYour request was not processed. Send it again if you still want me to carry it out.'

it("answers Hermes' command approvals itself in Full access while Hermes enforces edits", async () => {
  const replies: unknown[] = []
  const rig = await openAcpAdapterRig({
    spec: HERMES,
    launch: { fullAccess: true },
    script: (agent) =>
      agent.on('session/prompt', () => {
        void agent
          .request(7, 'session/request_permission', COMMAND_APPROVAL)
          .then((reply) => replies.push(reply))
      })
  })
  await rig.acquire({ permissionMode: 'full-access' })
  expect(rig.sent('session/set_config_option').map((frame) => frame.params)).toContainEqual(
    expect.objectContaining({ value: 'session' })
  )
  await sendHello(rig, 'send-1')
  await waitFor(() =>
    expect(replies).toEqual([
      expect.objectContaining({
        result: { outcome: { outcome: 'selected', optionId: 'allow_once' } }
      })
    ])
  )
})

it("shows the sign-in card in place of Hermes' not-connected reply", async () => {
  const rig = await openAcpAdapterRig({
    spec: HERMES,
    script: (agent) =>
      agent.on('session/prompt', (frame) => {
        agent.notify('session/update', {
          sessionId: PROVIDER_SESSION,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: '9303600a-7b88-4983-9a32-38fd63c85443',
            content: { type: 'text', text: NOT_CONNECTED }
          }
        })
        agent.fail(frame, -32603, 'Internal error', { details: 'admitted_turn_failed' })
      })
  })
  await rig.acquire()
  await sendHello(rig, 'send-1')
  const rows = await waitFor(async () => {
    const found = await rig.rig.rows()
    expect(
      found.some(
        (row) =>
          row.body.kind === 'status' &&
          readAgentSessionFailureFact(row.body.failure)?.kind === 'notSignedIn'
      )
    ).toBe(true)
    return found
  })
  expect(
    rows.filter((row) => row.body.kind === 'message' && row.body.role === 'assistant')
  ).toEqual([])
})

it("sends /compact as Hermes' own /compress", async () => {
  const rig = await openAcpAdapterRig({ spec: HERMES })
  new StructuredAgentRegistry([
    { definition: acpStructuredAgentDefinition(HERMES), adapter: rig.adapter }
  ])
  await rig.acquire()
  const turn = structuredAgentSessionCommandTurn('compact-1')
  const running = agentJournalTurnBody({ turnId: turn.turnId, state: 'running', startedAt: 4_000 })
  await rig.rig.journal.appendItem(turn.identity, running, {
    fence: 1,
    turnScope: { kind: 'thread' }
  })
  const command = { clientMessageId: 'compact-1', ...turn, running, instructions: 'the API' }
  await rig.adapter.compact({ sessionId: SESSION, fence: 1, command })
  const prompt = await rig.frame('session/prompt')
  expect(prompt.params).toMatchObject({ prompt: [{ type: 'text', text: '/compress the API' }] })
  rig.child().agent.reply(prompt, { stopReason: 'end_turn' })
  await waitFor(async () =>
    expect(readAgentJournalTurn((await rig.rig.rows())[0]?.body)?.state).not.toBe('running')
  )
})

function reopenRig(list: (agent: AcpScriptedAgent, frame: FakeFrame) => void) {
  return openAcpAdapterRig({
    spec: HERMES,
    launch: {
      resume: {
        sessionId: 'local-moved',
        key: 'acp-key-moved',
        mayBeUnsaved: async () => false,
        lossKeys: []
      }
    },
    initialize: { agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } } },
    script: (agent) => agent.on('session/list', (frame) => list(agent, frame))
  })
}

it('reopens a Hermes session only in the folder Hermes lists it in', async () => {
  const rig = await reopenRig((agent, frame) =>
    agent.reply(frame, {
      sessions: [{ sessionId: 'local-moved', cwd: '/workspace/project-worktree' }]
    })
  )
  await rig.acquire()
  expect(
    rig.sent('session/load').map((frame) => z.object({ cwd: z.string() }).parse(frame.params).cwd)
  ).toEqual(['/workspace/project-worktree'])
})

it('keeps the conversation when Hermes cannot list its sessions', async () => {
  const rig = await reopenRig((agent, frame) =>
    agent.fail(frame, -32603, 'Internal error', { details: 'storage_unavailable' })
  )
  await rig.acquire().catch(() => {})
  expect(rig.sent('session/load')).toEqual([])
  expect(rig.sent('session/new')).toEqual([])
})

it("leaves Hermes' questions to the person in Full access", async () => {
  const replies: unknown[] = []
  const rig = await openAcpAdapterRig({
    spec: HERMES,
    launch: { fullAccess: true },
    script: (agent) =>
      agent.on('session/prompt', () => {
        // Shaped as Hermes 0.23.1's clarify fallback (acp_adapter/elicitation.py) sends it.
        void agent
          .request(8, 'session/request_permission', {
            sessionId: PROVIDER_SESSION,
            toolCall: {
              toolCallId: 'clarify-p1',
              title: 'Which database?',
              kind: 'other',
              status: 'pending',
              content: [{ type: 'content', content: { type: 'text', text: 'Which database?' } }]
            },
            options: [
              { optionId: 'choice-0', name: 'Postgres', kind: 'allow_once' },
              { optionId: 'choice-1', name: 'SQLite', kind: 'allow_once' },
              { optionId: 'skip', name: 'Skip', kind: 'reject_once' }
            ]
          })
          .then((reply) => replies.push(reply))
      })
  })
  await rig.acquire({ permissionMode: 'full-access' })
  await sendHello(rig, 'send-1')
  await waitFor(async () =>
    expect((await rig.rig.rows()).map((row) => row.body.kind)).toContain('approval')
  )
  expect(replies).toEqual([])
})

it("starts Hermes without the chat's caller identity", async () => {
  const rig = await openAcpAdapterRig({
    spec: HERMES,
    launch: {
      env: { PATH: '/usr/bin', ORCA_AGENT_SESSION_ID: SESSION, ORCA_STRUCTURED_SESSION: '1' }
    }
  })
  await rig.acquire()
  const { env, envToDelete } = rig.child().launch
  expect(env).not.toHaveProperty('ORCA_AGENT_SESSION_ID')
  expect(env).toHaveProperty('ORCA_STRUCTURED_SESSION', '1')
  expect(envToDelete).toContain('ORCA_AGENT_SESSION_ID')
})

it('delivers the commands an agent reports while its chat is still starting', async () => {
  const paneOpen = deferred<void>()
  const { host, rig } = await openHostRig({
    spec: HERMES,
    script: (agent) => {
      // Hermes sends its list just after session/new, before Orca has set the permission mode.
      agent.on('session/new', (frame) => {
        void paneOpen.promise.then(() => {
          agent.reply(frame, { sessionId: PROVIDER_SESSION })
          agent.notify('session/update', {
            sessionId: PROVIDER_SESSION,
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: [{ name: 'app-build', description: 'Build the app' }]
            }
          })
        })
      })
      // Keep the chat starting so only the startup publish can carry the list.
      agent.on('session/set_config_option', () => {})
    }
  })
  const attached = await host.attach(
    CALLER,
    hostTestAttachParams(null, {
      provider: 'hermes',
      agent: 'hermes',
      accountHome: { variable: 'HERMES_HOME', path: '/hermes' },
      providerHandle: undefined
    })
  )
  expect(attached).toMatchObject({ ok: true })
  void send(host, 'hello')
  await rig.frame('session/new')
  const frames: AgentSessionSubscribeEvent[] = []
  await host.subscribe({ id: 'pane', sessionId: HOST_SESSION, emit: (frame) => frames.push(frame) })
  paneOpen.resolve()
  await waitFor(() =>
    expect(frames).toContainEqual(
      expect.objectContaining({ commands: [expect.objectContaining({ name: 'app-build' })] })
    )
  )
})

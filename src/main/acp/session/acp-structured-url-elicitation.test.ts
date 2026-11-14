import { afterEach, describe, expect, it } from 'vitest'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentSessionPromptResponse } from '../../../shared/agent-session/agent-session-question-answer'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  sendHello,
  waitFor,
  type AcpAdapterRig
} from './testing/acp-structured-adapter.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const URL = 'https://linear.app/oauth?x=1'
const signIn = (url: string) => ({
  sessionId: PROVIDER_SESSION,
  mode: 'url',
  elicitationId: 'linear-oauth-1',
  url,
  message: 'Authorize access to the Linear MCP server.'
})
// What Grok sends when an MCP server it runs asks for a URL or a form.
const grokElicit = (fields: Record<string, unknown>) => ({
  sessionId: PROVIDER_SESSION,
  toolCallId: 'mcp-elicit-1',
  serverName: 'linear',
  message: 'Authorize access',
  ...fields
})

async function promptingRig(): Promise<AcpAdapterRig> {
  const rig = await openAcpAdapterRig()
  await rig.acquire()
  await sendHello(rig, 'send-1')
  await rig.frame('session/prompt')
  return rig
}

async function promptRow(rig: AcpAdapterRig, kind: 'approval' | 'question') {
  return waitFor(async () => {
    const row = (await rig.rig.rows()).find((item) => item.body.kind === kind)
    expect(row).toBeDefined()
    return row!
  })
}

/** Answer as the host does: save the resolution, then reply to the agent. */
async function answer(
  rig: AcpAdapterRig,
  row: Awaited<ReturnType<typeof promptRow>>,
  response: AgentSessionPromptResponse,
  selectedOptionId: string
): Promise<void> {
  const body = row.body
  if (body.kind !== 'approval' && body.kind !== 'question') {
    throw new Error('expected a prompt row')
  }
  await rig.adapter.answerPrompt({
    sessionId: SESSION,
    itemId: row.itemId,
    kind: body.kind,
    response,
    fence: 1,
    commit: async () => {
      await rig.rig.journal.appendItem(
        parseAgentJournalItemKey(row.itemId)!,
        {
          ...body,
          resolution: {
            state: 'resolved',
            selectedOptionId,
            resolvedBy: 'desktop-renderer',
            resolvedAt: 5_000
          }
        },
        { fence: 1, turnScope: row.turnScope! }
      )
    }
  })
}

const open: AgentSessionPromptResponse = { kind: 'option', optionId: 'open' }

describe('ACP URL elicitation', () => {
  it('opens a card, accepts once the person opens the page, and marks it finished on complete', async () => {
    const rig = await promptingRig()
    expect((await rig.frame('initialize')).params).toMatchObject({
      clientCapabilities: { elicitation: { url: {} } }
    })
    const { agent } = rig.child()
    const reply = agent.request(9, 'elicitation/create', signIn(URL))
    const row = await promptRow(rig, 'approval')
    expect(row.body).toMatchObject({
      kind: 'approval',
      description: 'Authorize access to the Linear MCP server.',
      subject: { kind: 'url', url: URL },
      personOnly: true,
      options: [{ id: 'open' }, { id: 'decline' }],
      resolution: { state: 'pending' }
    })
    await answer(rig, row, open, 'open')
    expect((await reply).result).toEqual({ action: 'accept' })

    agent.notify('elicitation/complete', { elicitationId: 'unknown-id' })
    agent.notify('elicitation/complete', { elicitationId: 'linear-oauth-1' })
    await waitFor(async () => {
      expect((await rig.rig.row(row.itemId))?.body).toMatchObject({
        subject: { kind: 'url', url: URL, completedAt: 5_000 },
        resolution: { state: 'resolved', selectedOptionId: 'open' }
      })
    })
  })

  it('marks it finished when the agent completes it before the answer is saved', async () => {
    const rig = await promptingRig()
    const { agent } = rig.child()
    const reply = agent.request(9, 'elicitation/create', signIn(URL))
    const row = await promptRow(rig, 'approval')
    agent.notify('elicitation/complete', { elicitationId: 'linear-oauth-1' })
    await rig.settle()
    await answer(rig, row, open, 'open')
    expect((await reply).result).toEqual({ action: 'accept' })
    await waitFor(async () => {
      expect((await rig.rig.row(row.itemId))?.body).toMatchObject({
        subject: { kind: 'url', url: URL, completedAt: 5_000 },
        resolution: { state: 'resolved', selectedOptionId: 'open' }
      })
    })
  })

  it('refuses a URL that is not http(s) without showing a card', async () => {
    const rig = await promptingRig()
    const reply = await rig
      .child()
      .agent.request(9, 'elicitation/create', signIn('javascript:alert(1)'))
    expect(reply.error).toMatchObject({ code: -32602 })
    await rig.settle()
    expect((await rig.rig.rows()).some((item) => item.body.kind === 'approval')).toBe(false)
  })
})

describe("Grok's forwarded MCP elicitation", () => {
  it('shows a URL request on the sign-in card, answers in Grok’s shape, and finishes on its complete', async () => {
    const rig = await promptingRig()
    const { agent } = rig.child()
    const reply = agent.request(
      9,
      '_x.ai/mcp/elicit',
      grokElicit({ mode: 'url', url: URL, elicitationId: 'el-1' })
    )
    const row = await promptRow(rig, 'approval')
    expect(row.body).toMatchObject({
      description: 'linear: Authorize access',
      subject: { kind: 'url', url: URL }
    })
    await answer(rig, row, open, 'open')
    expect((await reply).result).toEqual({ outcome: 'accept' })

    agent.notify('_x.ai/mcp/elicit_complete', {
      sessionId: PROVIDER_SESSION,
      elicitationId: 'el-1',
      serverName: 'linear'
    })
    await waitFor(async () => {
      expect((await rig.rig.row(row.itemId))?.body).toMatchObject({
        subject: { kind: 'url', completedAt: 5_000 }
      })
    })
  })

  it('asks a form request on the question card and returns its content under outcome', async () => {
    const rig = await promptingRig()
    const reply = rig.child().agent.request(
      9,
      '_x.ai/mcp/elicit',
      grokElicit({
        mode: 'form',
        message: 'Which team?',
        requestedSchema: {
          type: 'object',
          properties: { team: { type: 'string', enum: ['Core', 'Mobile'] } },
          required: ['team']
        }
      })
    )
    const row = await promptRow(rig, 'question')
    expect(row.body).toMatchObject({ question: 'linear: Which team?' })
    await answer(
      rig,
      row,
      { kind: 'answers', answers: [{ questionId: 'q1', optionIds: ['o2'] }] },
      'o2'
    )
    expect((await reply).result).toEqual({ outcome: 'accept', content: { team: 'Mobile' } })
  })
})

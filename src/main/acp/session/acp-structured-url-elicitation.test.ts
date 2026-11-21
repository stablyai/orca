import { afterEach, describe, expect, it } from 'vitest'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentSessionPromptResponse } from '../../../shared/agent-session/requests/prompts/agent-session-question-answer'
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
  // Droid 1.16.0 asks a signed-out client to open its device sign-in page during session/new.
  it('cancels a sign-in page asked for before the session exists, so the chat reads signed out', async () => {
    const rig = await openAcpAdapterRig({
      script: (agent) =>
        agent.on('session/new', async (frame) => {
          const { sessionId: _, ...beforeSession } = signIn(URL)
          const { result } = await agent.request(0, 'elicitation/create', beforeSession)
          if (
            typeof result === 'object' &&
            result !== null &&
            'action' in result &&
            result.action === 'cancel'
          ) {
            agent.fail(frame, -32000, 'Authentication required: Sign-in was cancelled.')
          } else {
            agent.fail(frame, -32603, 'Internal error')
          }
        })
    })
    await rig.acquire()
    expect(rig.openVerdict()?.fact.kind).toBe('notSignedIn')
  })
})

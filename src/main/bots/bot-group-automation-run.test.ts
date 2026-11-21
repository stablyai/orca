import { describe, expect, it, vi } from 'vitest'
import type { AutomationRunMessage } from '../../shared/automations/automation-run-message'
import type { BotGroupMessage } from '../../shared/bots/bot-group'
import { targetInCallerChat } from '../runtime/rpc/methods/automations/runs-in-caller-chat'
import { withCheckedBotChat } from '../runtime/integrations/automations/runtime-automation-target'
import { fixture, groupNativeMocks, journal } from './bot-group-native-runtime.test-fixture'
import { noteBotGroupMemberReply } from './bot-group-latest'
import { botGroupRoomChat, sendBotGroupAutomationRun } from './bot-group-automation-run'

const mocks = groupNativeMocks()

const PROMPT = 'Check progress on the release and nudge whoever is behind.'
const RUN: AutomationRunMessage = {
  runId: 'run-1',
  automation: {
    id: 'auto-1',
    name: 'Progress check',
    enabled: true,
    nextRunAt: 0,
    updatedAt: 0,
    dtstart: 0,
    rrule: 'FREQ=MINUTELY;INTERVAL=15',
    workspaceId: 'folder:f1'
  },
  trigger: 'scheduled',
  instructionsLength: PROMPT.length
}

/** A room of PM (Scout) and Dev (Forge) whose chats answer with the replies `reply` records. */
async function room() {
  const setup = fixture()
  const { groups, runtime, bots } = setup
  const group = await groups.create({ name: 'Release', botIds: ['bot-0', 'bot-1'] })
  const [pm] = groups.store.get(group.id).members
  const replies = new Map<string, { operationId: string; text: string; at: number }[]>()
  mocks.snapshot.mockImplementation(async (sessionId) =>
    journal(sessionId, replies.get(sessionId) ?? [])
  )
  let at = 1
  const reply = async (message: BotGroupMessage, text: string) => {
    await vi.waitFor(() => expect(groups.store.pending()).toEqual([]))
    const turn = message.turns[0]!
    replies.set(turn.sessionId, [
      ...(replies.get(turn.sessionId) ?? []),
      { operationId: turn.operationId, text, at: at++ }
    ])
    await noteBotGroupMemberReply(runtime, turn.sessionId, `t-${turn.operationId}`)
  }
  const run = () =>
    sendBotGroupAutomationRun(groups, bots[0]!, pm!.sessionId, PROMPT, { automationRun: RUN })
  const lines = () => groups.store.messages(group.id, 100)
  return { ...setup, group, pm: pm!, reply, run, lines, newest: () => lines().at(-1)! }
}

describe('automations in group rooms', () => {
  it('saves a recurring automation made from a room turn to run in that room', async () => {
    const { runtime, groups, bots, group, pm } = await room()
    const target = await targetInCallerChat(
      runtime,
      pm.sessionId,
      { botId: 'bot-0', runsIn: 'new', resultsTo: 'chat' },
      false
    )
    expect(target).toEqual({
      botId: 'bot-0',
      runsIn: 'chat',
      resultsTo: 'chat',
      chat: { sessionId: pm.sessionId }
    })
    const saved = await withCheckedBotChat(target, bots[0], async (bot, id) =>
      botGroupRoomChat(groups, bot, id)
    )
    expect(saved?.chat).toEqual({ sessionId: pm.sessionId, title: group.name })
  })

  it("posts each run as the owner's post, and the member's @mention wakes the next member", async () => {
    const { run, reply, lines, newest } = await room()
    const sent = await run()
    const post = lines()[0]!
    expect(post).toMatchObject({ author: { kind: 'owner' }, text: PROMPT, automationRun: RUN })
    expect(post.turns.map((turn) => turn.botId)).toEqual(['bot-0'])
    expect(sent).toMatchObject({ clientMessageId: post.turns[0]!.operationId })
    const prompt: string = mocks.send.mock.calls[0]![0].turn.body.blocks[0].text
    expect(prompt.startsWith(PROMPT)).toBe(true)
    expect(prompt).toContain(`automation "Progress check", which ran here`)

    await reply(post, 'Release is at 80%. @Forge where is the migration?')
    expect(newest()).toMatchObject({ mentioned: true, rootRequestId: post.id })
    expect(newest().turns.map((turn) => turn.botId)).toEqual(['bot-1'])
  })

  it("sends the run to the member as that automation's run, with its event's images", async () => {
    const { groups, bots, pm } = await room()
    await sendBotGroupAutomationRun(groups, bots[0]!, pm.sessionId, PROMPT, {
      automationRun: RUN,
      memorySource: 'automation:Progress check',
      images: [{ path: '/tmp/event/screenshot.png' }]
    })
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1))
    expect(mocks.send.mock.calls[0]![0].turn.body).toMatchObject({
      origin: 'automation-run',
      automationRun: RUN,
      memorySource: 'automation:Progress check',
      blocks: [{ type: 'text' }, { type: 'image-ref', path: '/tmp/event/screenshot.png' }]
    })
  })

  it("stops with the room's Stop", async () => {
    const { groups, group, run, reply, lines } = await room()
    await run()
    await groups.stop(group.id)
    await reply(lines()[0]!, '@Forge status?')
    expect(lines()).toHaveLength(1)
  })

  it('refuses a run once its member left the room', async () => {
    const { groups, group, bots, pm, run, lines } = await room()
    await groups.update({
      groupId: group.id,
      revision: groups.store.get(group.id).revision,
      botIds: ['bot-1']
    })
    await expect(run()).rejects.toThrow(/no longer a member of that group room/)
    expect(botGroupRoomChat(groups, bots[0]!, pm.sessionId)).toBeNull()
    expect(lines()).toEqual([])
  })
})

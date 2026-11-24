import { describe, expect, it, vi } from 'vitest'
import type { BotAgent } from '../../../../shared/bot-types'
import type * as Lineage from '../../orchestration/addressing/session-lineage/structured-session-lineage'
import type { RpcContext } from '../core'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { COMMANDER_CHAT_OPEN, COMMANDER_CHAT_RECENT } from './commander-chat'
import { hostBotAgentChoices } from './bots-agent-choices'

vi.mock('./bots-agent-choices', () => ({ hostBotAgentChoices: vi.fn() }))

vi.mock(
  '../../orchestration/addressing/session-lineage/structured-session-lineage',
  async (importOriginal) => ({
    ...(await importOriginal<typeof Lineage>()),
    readAgentSessionRecordStore: () => ({
      getRecord: (id: string) =>
        id === 'chat-1'
          ? {
              location: { workspaceId: 'folder:w1', executionHostId: 'local' },
              lastTurn: { state: 'settled', prompt: 'Ship the change', reply: 'Build passed' }
            }
          : null
    })
  })
)

function open(caller: RpcContext['caller']) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: opening Commander only calls these two runtime ports; provider discovery is replaced above.
  const runtime = {
    requireStore: () => ({ getSettings: () => ({ defaultTuiAgent: 'codex' }) }),
    bots: {
      ensureCommander: async (choose: () => Promise<BotAgent>) => ({
        ...makeTestBot(),
        agent: await choose()
      })
    }
  } as unknown as RpcContext['runtime']
  return COMMANDER_CHAT_OPEN.handler(undefined, { caller, runtime })
}

describe('Commander Chat owner entry', () => {
  it('rejects agent and unidentified transports before opening the conversation', async () => {
    await expect(open({ kind: 'local-cli' })).rejects.toThrow('Only the owner')
    await expect(
      open({ kind: 'paired-device', deviceId: 'external', agent: true })
    ).rejects.toThrow('Only the owner')
    await expect(open(undefined)).rejects.toThrow('authenticated')
  })
  it('selects the configured runnable provider from a paired phone and reports a host without one', async () => {
    vi.mocked(hostBotAgentChoices).mockResolvedValueOnce(['claude', 'codex'])
    await expect(open({ kind: 'paired-device', deviceId: 'phone' })).resolves.toMatchObject({
      bot: { agent: 'codex' }
    })
    vi.mocked(hostBotAgentChoices).mockResolvedValueOnce([])
    await expect(open({ kind: 'desktop' })).rejects.toThrow('Set up a chat agent')
  })
})

it('reads an existing Commander home without starting a provider or borrowing another chat', async () => {
  const core = makeTestBot({ systemRole: 'commander', chatSessionId: 'chat-1' })
  const store = { getBots: () => [core] }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the preview reads only the catalog and the existing record store.
  const runtime = {
    requireStore: () => store,
    ensureStructuredAgentSessionHost: async () => undefined
  } as unknown as RpcContext['runtime']
  const caller = { kind: 'desktop' } as const
  const recent = () => COMMANDER_CHAT_RECENT.handler(undefined, { caller, runtime })
  expect(await recent()).toEqual({ goal: 'Ship the change', progress: 'Build passed' })
  core.folderWorkspaceId = 'other'
  expect(await recent()).toEqual({ goal: '', progress: '' })
  await expect(
    COMMANDER_CHAT_RECENT.handler(undefined, { caller: { kind: 'local-cli' }, runtime })
  ).rejects.toThrow('Only the owner')
})

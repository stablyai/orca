import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { botSessionInstructions } from './bot-session-instructions'
import { createBotTurnContext } from './bot-turn-context'
import { makeTestBot } from './bot.test-fixture'
import { HELD_BOT_RULES } from './bot-turn-rules.test-fixture'

const FOLDER = join('bot-homes', 'release-manager')
const OWNER: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'Check the release.' }]
}

function home(provider: 'codex' | 'claude') {
  const bot = makeTestBot({ name: 'Release Manager', agent: provider })
  const files = new Map([
    [join(FOLDER, 'SOUL.md'), 'Write release notes from merged pull requests.'],
    [join(FOLDER, 'MEMORY.md'), '- Release notes belong in the release body.']
  ])
  const fs = {
    readText: async (path: string) => files.get(path) ?? null,
    writeText: async () => false,
    replaceText: async () => false
  }
  const context = createBotTurnContext(fs)
  return { bot, fs, context, files }
}

async function resumeWithoutReceipt(provider: 'codex' | 'claude') {
  const { bot, fs, context } = home(provider)
  const instructions = await botSessionInstructions(
    context,
    [bot],
    {
      sessionId: 'release-chat',
      provider,
      location: { workspaceId: `folder:${bot.folderWorkspaceId}` },
      providerHandleChain: [{ id: 'thread-without-bot-instructions' }],
      instructionsEachStart: false
    },
    FOLDER,
    null,
    fs
  )
  return { context, instructions }
}

describe('bot instructions for a provider thread opened without them', () => {
  it.each(['owner', 'automation'] as const)(
    'restores identity, tools and rules before the first Codex %s turn',
    async (source) => {
      const { context } = await resumeWithoutReceipt('codex')
      const plan =
        source === 'owner'
          ? await context.plan('release-chat', OWNER)
          : await context.launchUpdate?.('release-chat')

      expect
        .soft(plan?.providerInstructions?.text ?? '')
        .toContain('You are Release Manager, a bot that runs in Orca.')
      expect.soft(plan?.providerInstructions?.text ?? '').toContain('## Tools')
      expect.soft(plan?.providerInstructions?.text ?? '').toContain('## Rules')
    }
  )

  it('adds no recovery to a fresh Codex context whose launch delivery is already proven', async () => {
    const { context, bot, files } = home('codex')
    // Accepted-state fixture only; host/store tests must prove the actual start and receipt commit.
    context.launched(
      'release-chat',
      bot.id,
      FOLDER,
      {
        soul: files.get(join(FOLDER, 'SOUL.md')) ?? null,
        memory: files.get(join(FOLDER, 'MEMORY.md')) ?? null
      },
      true,
      HELD_BOT_RULES
    )

    expect(await context.plan('release-chat', OWNER)).toBeNull()
    expect(await context.launchUpdate?.('release-chat')).toBeNull()
  })

  it('keeps the Claude resume preamble and receipt-backed turn updates without Codex recovery', async () => {
    const { context, instructions } = await resumeWithoutReceipt('claude')

    expect(instructions).toContain('You are Release Manager, a bot that runs in Orca.')
    expect(instructions).toContain('## Tools')
    expect(instructions).toContain('## Rules')
    const owner = await context.plan('release-chat', OWNER)
    const automation = await context.launchUpdate?.('release-chat')
    expect(owner?.text ?? '').toContain('[Orca rules update:')
    expect(automation?.text ?? '').toContain('[Orca rules update:')
    expect(owner?.providerInstructions).toBeUndefined()
    expect(automation?.providerInstructions).toBeUndefined()
  })
})

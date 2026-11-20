import { join, sep } from 'node:path'
import { HELD_BOT_RULES, TAKEN } from './bot-turn-rules.test-fixture'
import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { type BotFirstRun, createBotTurnContext } from './bot-turn-context'
import type { BotRecentChatsSection } from './bot-recent-chats'
import { botSessionInstructions } from './bot-session-instructions'
import { botRulesBlock } from './bot-preamble'
import { botRulesKey } from './bot-turn-rules-update'
import { codexItemBody } from '../codex/structured/items/codex-structured-item-translation'

const FOLDER = '/home/me/.orca/bots/scout'

function home(
  soul: string,
  memory: string,
  firstRun?: BotFirstRun,
  topics: Record<string, string> = {}
) {
  const files = new Map([
    [join(FOLDER, 'SOUL.md'), soul],
    [join(FOLDER, 'MEMORY.md'), memory],
    ...Object.entries(topics).map(([name, text]) => [join(FOLDER, 'memory', name), text] as const)
  ])
  const fs = {
    readText: async (path: string) => files.get(path) ?? null,
    listNames: async (dir: string) =>
      [...files.keys()].flatMap((path) =>
        path.startsWith(`${dir}${sep}`) ? [path.slice(dir.length + 1)] : []
      ),
    replaceText: async () => false,
    writeText: async () => false
  }
  const context = createBotTurnContext(fs, firstRun)
  context.launched('s1', 'bot-1', FOLDER, { soul, memory }, true, HELD_BOT_RULES)
  // Each turn end reads the journal as it stands; a turn adds its rows.
  const journal: AgentJournalRenderItem[] = []
  /** A turn: its start takes what it is sent, `during` runs, then its rows and its end. */
  const turnWith = async (during: () => void, ...bodies: AgentJournalItemBody[]) => {
    ;(await context.plan('s1', { kind: 'message', role: 'user', blocks: [] }))?.given(TAKEN)
    during()
    for (const body of bodies) {
      journal.push({
        itemId: `i${journal.length}`,
        revision: 1,
        sequence: journal.length + 1,
        observedAt: 1,
        body
      })
    }
    context.turnEnded?.('s1', `t${journal.length}`, async () => ({
      items: journal,
      openerIds: new Map()
    }))
    await settle()
  }
  return {
    context,
    fs,
    turn: (...bodies: AgentJournalItemBody[]) => turnWith(() => {}, ...bodies),
    turnWith,
    edit: (file: string, text: string | null) =>
      text === null ? files.delete(join(FOLDER, file)) : files.set(join(FOLDER, file), text),
    plan: (sessionId = 's1') =>
      context.plan(sessionId, { kind: 'message', role: 'user', blocks: [] })
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('first-run rules in a bot chat', () => {
  const text = (value: string) => [{ type: 'text' as const, text: value }]
  const mail = { kind: 'agent' as const, senders: [], orchestration: null }

  /** A Chat whose turn ends read SOUL.md through `gate`, so a test can hold an end mid-way. */
  function chat() {
    let gate: Promise<void> = Promise.resolve()
    const ended: string[] = []
    const fs = {
      readText: async (path: string) => {
        await gate
        return path.endsWith('SOUL.md') ? '# Pulse\n\nWatches startup time.\n' : ''
      },
      replaceText: async () => false,
      writeText: async () => false
    }
    const context = createBotTurnContext(fs, {
      rules: () => null,
      ownerTurnEnded: (botId, sessionId) => ended.push(`${botId}:${sessionId}`)
    })
    context.launched('s1', 'bot-1', FOLDER, { soul: null, memory: null }, true, HELD_BOT_RULES)
    const journal: AgentJournalRenderItem[] = []
    const row = (itemId: string, body: AgentJournalItemBody) =>
      journal.push({ itemId, revision: 1, sequence: journal.length + 1, observedAt: 1, body })
    /** A turn opened by `opener`, still running or ended. */
    const open = (turnId: string, opener: AgentJournalItemBody, state: 'running' | 'completed') => {
      row(`msg-${turnId}`, opener)
      row(`turn-${turnId}`, { kind: 'turn', turnId, state, userItemId: `msg-${turnId}` })
    }
    const complete = (turnId: string) =>
      row(`turn-${turnId}`, {
        kind: 'turn',
        turnId,
        state: 'completed',
        userItemId: `msg-${turnId}`
      })
    const end = (turnId: string) =>
      context.turnEnded?.('s1', turnId, async () => ({ items: journal, openerIds: new Map() }))
    return { ended, open, complete, end, hold: (until: Promise<void>) => (gate = until) }
  }

  it("end only when a turn the owner opened ends, never Orca's or anyone else's", async () => {
    const { ended, open, end } = chat()
    const others: [string, AgentJournalItemBody][] = [
      ['kickoff', { kind: 'message', role: 'user', blocks: text('k'), origin: 'bot-created' }],
      ['auto', { kind: 'message', role: 'user', blocks: text('9am'), memorySource: 'auto' }],
      ['mail', { kind: 'message', role: 'user', blocks: text('done'), from: mail }],
      ['slack', { kind: 'message', role: 'user', blocks: text('hi'), origin: 'connector' }]
    ]
    for (const [turnId, opener] of others) {
      open(turnId, opener, 'completed')
      end(turnId)
      await settle()
    }
    expect(ended).toEqual([])
    open('owner', { kind: 'message', role: 'user', blocks: text('The desktop app.') }, 'completed')
    end('owner')
    await settle()
    expect(ended).toEqual(['bot-1:s1'])
  })

  it("keep going when the owner's next turn starts while an automation's end is still reading", async () => {
    const { ended, open, complete, end, hold } = chat()
    const read = Promise.withResolvers<void>()
    hold(read.promise)
    open(
      'auto',
      { kind: 'message', role: 'user', blocks: text('9am'), memorySource: 'a' },
      'completed'
    )
    end('auto')
    // Before that end reads the journal, the owner writes and their turn starts.
    open('owner', { kind: 'message', role: 'user', blocks: text('The desktop app.') }, 'running')
    read.resolve()
    await settle()
    expect(ended).toEqual([])
    complete('owner')
    end('owner')
    await settle()
    expect(ended).toEqual(['bot-1:s1'])
  })

  it('ride every turn while first run lasts, and stop with it', async () => {
    let inFirstRun = true
    const { context, plan } = home('# Pulse\n', '', {
      rules: () => (inFirstRun ? 'FIRST RUN RULES' : null),
      ownerTurnEnded: () => {}
    })
    expect((await plan())?.text).toContain('FIRST RUN RULES')
    expect((await context.launchUpdate?.('s1'))?.text).toContain('FIRST RUN RULES')
    inFirstRun = false
    expect(await plan()).toBeNull()
    expect(await context.launchUpdate?.('s1')).toBeNull()
  })
})

describe('a bot chat turn context', () => {
  it("carries the conversation's worker note with no row of its own", async () => {
    const fs = {
      readText: async () => null,
      replaceText: async () => false,
      writeText: async () => false
    }
    const context = createBotTurnContext(fs, undefined, undefined, async (sessionId, message) =>
      sessionId === 's1' && message.origin === 'connector' ? '[Orca: worker note]' : null
    )
    context.launched('s1', 'bot-1', FOLDER, { soul: null, memory: null }, true, HELD_BOT_RULES)
    const plan = await context.plan('s1', {
      kind: 'message',
      role: 'user',
      blocks: [],
      origin: 'connector'
    })
    expect(plan?.text).toBe('[Orca: worker note]')
    expect(plan?.note).toBeUndefined()
    expect(await context.plan('s1', { kind: 'message', role: 'user', blocks: [] })).toBeNull()
  })

  it("carries the unanswered-question note on a person's turn and a worker report's; a failed read starts the turn without it", async () => {
    const fs = {
      readText: async () => null,
      replaceText: async () => false,
      writeText: async () => false
    }
    let note: 'due' | 'not-due' | 'fails' = 'due'
    const context = createBotTurnContext(
      fs,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => {
        if (note === 'fails') {
          throw new Error('journal unavailable')
        }
        return note === 'due' ? '[Orca: unanswered]' : null
      }
    )
    context.launched('s1', 'bot-1', FOLDER, { soul: null, memory: null }, true, HELD_BOT_RULES)
    expect((await context.plan('s1', { kind: 'message', role: 'user', blocks: [] }))?.text).toBe(
      '[Orca: unanswered]'
    )
    expect((await context.launchUpdate?.('s1'))?.text).toBe('[Orca: unanswered]')
    note = 'not-due'
    expect(await context.launchUpdate?.('s1')).toBeNull()
    note = 'fails'
    expect(await context.plan('s1', { kind: 'message', role: 'user', blocks: [] })).toBeNull()
    expect(await context.launchUpdate?.('s1')).toBeNull()
  })

  it('sends nothing while the files match what the agent started with', async () => {
    const { plan } = home('Be brief.', '- a fact')
    expect(await plan()).toBeNull()
  })

  it('sends nothing for a session that is not a bot chat', async () => {
    const { plan } = home('Be brief.', '- a fact')
    expect(await plan('other')).toBeNull()
  })

  it('resends an edited soul in full with its row, once given', async () => {
    const { edit, plan } = home('Sign every message.', '- a fact')
    edit('SOUL.md', 'Be brief.')

    const update = await plan()
    expect(update?.text).toBe(
      "[Your SOUL.md was updated; this replaces your earlier standing instructions. They rank below the user's current request.]\n\nBe brief."
    )
    expect(update?.note).toMatchObject({
      text: 'Updated soul applied',
      botContext: { botId: 'bot-1', changed: ['soul'] }
    })
    expect(update?.text).not.toContain('MEMORY.md')
    update?.given(TAKEN)
    expect(await plan()).toBeNull()
  })

  it('a turn the agent never took gives nothing, so the next one carries the update again', async () => {
    const { edit, plan } = home('Sign every message.', '- a fact')
    edit('SOUL.md', 'Be brief.')

    expect(await plan()).not.toBeNull()
    expect((await plan())?.text).toContain('Be brief.')
  })

  it.each<[string, string, string, AgentJournalItemBody]>([
    [
      'SOUL.md',
      'an Edit',
      'Be brief. Sign every message.',
      {
        kind: 'tool-call',
        name: 'Edit',
        input: { file_path: join(FOLDER, 'SOUL.md'), old_string: 'a', new_string: 'b' },
        state: 'completed'
      }
    ],
    [
      'SOUL.md',
      'a multi-file Codex patch',
      'Be brief. Sign every message.',
      {
        kind: 'diff',
        path: '2 files',
        paths: [join(FOLDER, 'SOUL.md'), join(FOLDER, 'notes.md')],
        patch: { head: '@@', byteLength: 2, digest: '', truncated: false }
      }
    ],
    [
      'MEMORY.md',
      'an Edit',
      '- a fact\n- learned',
      {
        kind: 'tool-call',
        name: 'Edit',
        input: { file_path: join(FOLDER, 'MEMORY.md'), old_string: 'a', new_string: 'b' },
        state: 'completed'
      }
    ]
  ])('sends nothing after the bot changes %s through %s', async (file, _, edited, write) => {
    const { edit, plan, turn, turnWith } = home('Be brief.', '- a fact')
    await turn()
    await turnWith(() => edit(file, edited), write)

    expect(await plan()).toBeNull()
  })

  describe("the bot's own SOUL.md edit, which no record tracks", () => {
    const path = join(FOLDER, 'SOUL.md')
    const edited = 'Be brief. Sign every message.'

    it.each<[string, AgentJournalItemBody]>([
      [
        'a Read of it',
        { kind: 'tool-call', name: 'Read', input: { file_path: path }, state: 'completed' }
      ],
      [
        'a failed Edit of it',
        {
          kind: 'tool-call',
          name: 'Edit',
          input: { file_path: path, old_string: 'a', new_string: 'b' },
          state: 'failed'
        }
      ],
      [
        'a failed Codex patch',
        codexItemBody({
          type: 'fileChange',
          id: 'patch-1',
          status: 'failed',
          changes: [
            { path, kind: { type: 'update' }, diff: '@@ -1 +1 @@' },
            { path: join(FOLDER, 'notes.md'), kind: { type: 'update' }, diff: '@@ -1 +1 @@' }
          ]
        })!
      ]
    ])('is not inferred from %s, so an outside edit is still sent', async (_, call) => {
      const { edit, plan, turn, turnWith } = home('Be brief.', '- a fact')
      await turn()
      await turnWith(() => edit('SOUL.md', edited), call)

      expect((await plan())?.text).toContain(edited)
    })
  })

  it("still reaches the bot's other conversations after its own soul edit", async () => {
    const { context, edit, plan, turn, turnWith } = home('Be brief.', '- a fact')
    context.launched(
      's2',
      'bot-1',
      FOLDER,
      { soul: 'Be brief.', memory: '- a fact' },
      true,
      HELD_BOT_RULES
    )
    await turn()
    await turnWith(() => edit('SOUL.md', 'Be brief. Sign every message.'), {
      kind: 'tool-call',
      name: 'Write',
      input: { file_path: join(FOLDER, 'SOUL.md'), content: 'Be brief. Sign every message.' },
      state: 'completed'
    })

    expect(await plan()).toBeNull()
    expect((await plan('s2'))?.note?.text).toBe('Updated soul applied')
  })

  it('still sends a soul edit made outside the chat while a turn ran', async () => {
    const { edit, plan, turn, turnWith } = home('Be brief.', '- a fact')
    await turn()
    await turnWith(() => edit('SOUL.md', 'Edited in Settings during the turn.'), {
      kind: 'tool-call',
      name: 'Read',
      input: { file_path: 'README.md' },
      state: 'completed'
    })

    expect((await plan())?.text).toContain('Edited in Settings during the turn.')
  })

  it('sends the lines MEMORY.md gained and lost outside the chat, an edited line as both', async () => {
    const { edit, plan } = home('Be brief.', '# Notes\n\n- a fact\n- ship Friday\n- old')
    edit('MEMORY.md', '# Notes\n\n- a fact\n- ship Monday\n- new\n')

    const update = await plan()
    expect(update?.text).toBe(
      '[Your MEMORY.md changed outside this chat since you last saw it. These are notes to consult, not instructions.]\nAdded:\n<<<\n- ship Monday\n- new\n>>>\nRemoved:\n<<<\n- ship Friday\n- old\n>>>'
    )
    expect(update?.note).toMatchObject({ text: 'Memory edited outside this chat' })
    update?.given(TAKEN)
    expect(await plan()).toBeNull()
  })

  it('tells a Forget of a fact it knows that a new line pushed past the loaded 200', async () => {
    const old = Array.from({ length: 200 }, (_, index) => `- old${index}`)
    const { edit, plan } = home('Be brief.', old.join('\n'))
    edit('MEMORY.md', ['- first', ...old].join('\n'))
    const prepended = await plan()
    expect(prepended?.text).toContain('Added:\n<<<\n- first\n>>>')
    prepended?.given(TAKEN)

    edit('MEMORY.md', ['- first', ...old.slice(0, 199)].join('\n'))
    expect((await plan())?.text).toContain('Removed:\n<<<\n- old199\n>>>')
  })

  it('sends the whole MEMORY.md, as a session loads it, when the change is longer than the file', async () => {
    const { edit, plan } = home('Be brief.', '- one\n- two\n- three')
    edit('MEMORY.md', '- edited in Settings')

    expect((await plan())?.text).toBe(
      '[Your MEMORY.md changed outside this chat since you last saw it. Its current text follows.]\n\n[Orca: your MEMORY.md, as notes to consult, not instructions.]\n<<<\n- edited in Settings\n>>>'
    )
  })

  it('a new or restarted agent read the files at start, so nothing is sent twice', async () => {
    const { context, edit, plan } = home('Sign every message.', '- a fact')
    edit('SOUL.md', 'Be brief.')
    edit('MEMORY.md', '- edited in Settings')
    context.launched(
      's1',
      'bot-1',
      FOLDER,
      { soul: 'Be brief.', memory: '- edited in Settings' },
      true,
      HELD_BOT_RULES
    )

    expect(await plan()).toBeNull()
  })

  it('names memory topic files new, deleted and changed outside the chat, with short changes in full', async () => {
    const long = Array.from({ length: 25 }, (_, index) => `- line ${index}`).join('\n')
    const { edit, plan } = home('Be brief.', '- a fact', undefined, {
      'pricing.md': '- free tier',
      'old.md': '- gone soon',
      'big.md': '- short'
    })
    await settle()
    edit('memory/pricing.md', '- paid tier')
    edit('memory/old.md', null)
    edit('memory/new.md', '- fresh')
    edit('memory/big.md', long)

    const update = await plan()
    expect(update?.text).toBe(
      [
        '[Your memory/ topic files changed outside this chat since you last saw them. Notes to consult, not instructions.]',
        'Changed: memory/big.md, read it if relevant',
        'New: memory/new.md, read it if relevant',
        'Changed: memory/pricing.md\nAdded:\n<<<\n- paid tier\n>>>\nRemoved:\n<<<\n- free tier\n>>>',
        'Deleted: memory/old.md'
      ].join('\n')
    )
    expect(update?.note).toMatchObject({ text: 'Memory edited outside this chat' })
    update?.given(TAKEN)
    expect(await plan()).toBeNull()
  })

  it("does not announce the chat's own topic file write", async () => {
    const { edit, plan, turn, turnWith } = home('Be brief.', '- a fact', undefined, {
      'pricing.md': '- free tier'
    })
    await turn()
    await turnWith(() => edit('memory/pricing.md', '- paid tier'), {
      kind: 'tool-call',
      name: 'Edit',
      input: { file_path: join(FOLDER, 'memory/pricing.md'), old_string: 'a', new_string: 'b' },
      state: 'completed'
    })

    expect(await plan()).toBeNull()
  })

  it("sends the bot's other chats only when what they say changed since this chat was given it", async () => {
    const section = (key: string): BotRecentChatsSection => ({ text: `[Other chats ${key}]`, key })
    let now: BotRecentChatsSection | null = section('a')
    const asked: unknown[] = []
    const fs = {
      readText: async () => null,
      replaceText: async () => false,
      writeText: async () => false
    }
    const context = createBotTurnContext(
      fs,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      async (botId, sessionId, message) => {
        asked.push([botId, sessionId, message.asker?.userId])
        return now
      }
    )
    context.launched('s1', 'bot-1', FOLDER, { soul: null, memory: null }, true, HELD_BOT_RULES)
    const slack = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'which tier?' }],
      origin: 'connector' as const,
      asker: {
        source: 'slack' as const,
        userId: 'U0SAM',
        role: 'member' as const,
        place: { kind: 'public_channel' as const, id: 'C9' }
      }
    }

    const first = await context.plan('s1', slack)
    expect(first?.text).toBe('[Other chats a]')
    expect(first?.note).toBeUndefined()
    expect(asked).toEqual([['bot-1', 's1', 'U0SAM']])
    // Not taken: the next turn carries it again.
    expect((await context.plan('s1', slack))?.text).toBe('[Other chats a]')
    ;(await context.plan('s1', slack))?.given(TAKEN)
    expect(await context.plan('s1', slack)).toBeNull()
    now = section('b')
    expect((await context.plan('s1', slack))?.text).toBe('[Other chats b]')
    now = null
    expect(await context.plan('s1', slack)).toBeNull()
  })

  it('carries both changes in one turn and one row', async () => {
    const { edit, plan } = home('Sign every message.', '- a fact')
    edit('SOUL.md', 'Be brief.')
    edit('MEMORY.md', '- edited in Settings')

    const update = await plan()
    expect(update?.text.indexOf('SOUL.md')).toBeLessThan(update?.text.indexOf('MEMORY.md') ?? 0)
    expect(update?.note?.text).toBe('Updated soul applied · Memory edited outside this chat')
  })

  describe('what a launch gave its agent', () => {
    const bots = [{ id: 'bot-1', name: 'Scout', agent: 'claude' as const, folderWorkspaceId: 'ws' }]
    const launch = (provider: string, resumed: boolean) => ({
      sessionId: 's1',
      provider,
      location: { workspaceId: 'folder:ws' },
      providerHandleChain: resumed ? [{}] : []
    })

    it('a resumed Codex conversation keeps its first instructions, so the next turn sends the soul', async () => {
      const { context, fs, plan } = home('Old soul.', '- a fact')
      await botSessionInstructions(context, bots, launch('codex', true), FOLDER, null, fs)

      expect((await plan())?.text).toContain('Old soul.')
    })

    // Nothing is said; the turn only vouches for the Tools and Rules the launch gave.
    it.each(['pi', 'copilot', 'aug', 'goose', 'kilo', 'qwen-code'])(
      'a resumed %s conversation reads them again, so nothing is sent',
      async (provider) => {
        const { context, edit, fs, plan } = home('Old soul.', '- a fact')
        edit('SOUL.md', 'New soul.')
        await botSessionInstructions(context, bots, launch(provider, true), FOLDER, null, fs)

        expect((await plan())?.text).toBe('')
      }
    )

    it('a new Codex thread starts with them, so nothing is sent', async () => {
      const { context, edit, fs, plan } = home('Old soul.', '- a fact')
      edit('SOUL.md', 'New soul.')
      await botSessionInstructions(context, bots, launch('codex', false), FOLDER, null, fs)

      expect((await plan())?.text).toBe('')
    })
  })
})

describe("a bot chat's linked-project skills", () => {
  const SECTION = '## Skills from linked projects\n\nSkills from orca: use them to plan.'
  const textOf = async (h: ReturnType<typeof home>): Promise<string> => (await h.plan())?.text ?? ''

  it('sends the current list on the first turn of a resumed chat, whose instructions stay its first ones', async () => {
    const h = home('Be brief.', '- a fact')
    h.context.linkedSkillsLaunched('s1', SECTION, false)
    const first = await h.plan()
    expect(first?.text).toContain(SECTION)
    first?.given(TAKEN)
    expect(await textOf(h)).not.toContain(SECTION)
  })

  it('sends nothing more when the instructions carried it', async () => {
    const h = home('Be brief.', '- a fact')
    h.context.linkedSkillsLaunched('s1', SECTION, true)
    expect(await textOf(h)).not.toContain(SECTION)
  })

  it('sends the list once the agent turns down the folders it was told it loaded', async () => {
    const h = home('Be brief.', '- a fact')
    h.context.linkedSkillsLaunched('s1', 'loaded natively', true)
    h.context.linkedSkillsLaunched('s1', SECTION, false)
    expect(await textOf(h)).toContain(SECTION)
  })
  it('replaces an earlier list with none when the last project was unlinked, on a resumed chat', async () => {
    const h = home('Be brief.', '- a fact')
    h.context.linkedSkillsLaunched('s1', null, false)
    const first = await h.plan()
    expect(first?.text).toContain('no skills from linked projects now')
    first?.given(TAKEN)
    expect(await textOf(h)).not.toContain('linked projects')
  })

  it("rides a worker's report through the launch update, given once", async () => {
    const h = home('Be brief.', '- a fact')
    h.context.linkedSkillsLaunched('s1', SECTION, false)
    const update = await h.context.launchUpdate?.('s1')
    expect(update?.text).toContain(SECTION)
    update?.given(TAKEN)
    expect(await h.context.launchUpdate?.('s1')).toBeNull()
  })

  it('has no launch update for a fresh chat without linked projects', async () => {
    const h = home('Be brief.', '- a fact')
    h.context.linkedSkillsLaunched('s1', null, true)
    expect(await h.context.launchUpdate?.('s1')).toBeNull()
  })
})

describe('a project linked while a bot chat runs', () => {
  const NEW_LIST =
    '[The skills from your linked projects, as they are now; this replaces any earlier list.]\n\norca: review -> /orca/.agents/skills/review/SKILL.md'

  function running(launchScanned: string[] = [], linkedAtLaunch: string[] = []) {
    const state = { linked: linkedAtLaunch }
    const fs = {
      readText: async (path: string) =>
        path === join(FOLDER, 'SOUL.md')
          ? 'Be brief.'
          : path === join(FOLDER, 'MEMORY.md')
            ? '- a fact'
            : null,
      replaceText: async () => false,
      writeText: async () => false
    }
    const context = createBotTurnContext(fs, undefined, undefined, undefined, undefined, {
      projects: () => state.linked,
      launchScanned: () => launchScanned,
      listed: async (_botId, projects) =>
        projects.length > 0 ? 'orca: review -> /orca/.agents/skills/review/SKILL.md' : null
    })
    context.launched(
      's1',
      'bot-1',
      FOLDER,
      { soul: 'Be brief.', memory: '- a fact' },
      true,
      HELD_BOT_RULES
    )
    context.linkedSkillsLaunched('s1', null, true)
    const plan = () => context.plan('s1', { kind: 'message', role: 'user', blocks: [] })
    return { state, context, plan }
  }

  it('gives the running chat the new list on its next turn, once', async () => {
    const { state, plan } = running()
    expect(await plan()).toBeNull()

    state.linked = ['repo-orca']
    const next = await plan()
    expect(next?.text).toBe(NEW_LIST)
    next?.given(TAKEN)
    expect(await plan()).toBeNull()
  })

  it('rides a turn without a plan too: a worker report or a message with attachments', async () => {
    const { state, context } = running()
    state.linked = ['repo-orca']
    expect((await context.launchUpdate?.('s1'))?.text).toBe(NEW_LIST)
  })

  it("compares with the projects the launch scanned, not the store's later value", async () => {
    // Linked while the launch read its home files: the store has it, the scan had none of it.
    const { plan } = running([], ['repo-orca'])
    expect((await plan())?.text).toBe(NEW_LIST)
  })
})

describe('the empty linked-skills replacement on a resumed chat', () => {
  const bot = { id: 'bot-1', name: 'Scout', agent: 'codex' as const, folderWorkspaceId: 'ws' }
  const resumed = {
    sessionId: 's1',
    provider: 'codex',
    location: { workspaceId: 'folder:ws' },
    providerHandleChain: [{}],
    instructionsKey: botRulesKey(botRulesBlock('codex'))
  }

  it('omits a linked-project update when the resumed bot never linked a project', async () => {
    const h = home('Be brief.', '- a fact')
    await botSessionInstructions(h.context, [bot], resumed, FOLDER, null, h.fs)
    const update = await h.context.launchUpdate?.('s1')
    expect(update?.text).toContain('Be brief.')
    expect(update?.text).not.toContain('no skills from linked projects now')
  })

  it('is sent once its projects were all unlinked', async () => {
    const h = home('Be brief.', '- a fact')
    await botSessionInstructions(
      h.context,
      [{ ...bot, skillProjects: [] }],
      resumed,
      FOLDER,
      null,
      h.fs
    )
    expect((await h.context.launchUpdate?.('s1'))?.text).toContain(
      'no skills from linked projects now'
    )
  })
})

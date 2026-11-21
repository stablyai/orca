import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { HELD_BOT_RULES, TAKEN } from './bot-turn-rules.test-fixture'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalRenderItem
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { parseBotMemoryFacts } from '../../shared/bot-memory-lines'
import { botMemorySourcesOf } from '../../shared/bots/bot-memory-source'
import { localBotHomeFilesystem } from './bot-home'
import { createBotMemoryRecord } from './bot-memory-record'
import { createBotTurnContext } from './bot-turn-context'

const FOLDER = '/home/me/.orca/bots/scout'
const MEMORY = join(FOLDER, 'MEMORY.md')

const said = (
  text: string,
  extra: Pick<AgentJournalMessageItem, 'origin' | 'asker' | 'memorySource'> = {}
): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }],
  ...extra
})
const asker = (name: string) => ({
  origin: 'connector' as const,
  asker: {
    source: 'slack' as const,
    userId: `U-${name}`,
    name,
    role: 'member' as const,
    place: { kind: 'public_channel' as const, id: 'C1' },
    url: 'https://app.slack.com/client/T1/C1'
  }
})
/** The bot writing `line` into MEMORY.md, as its edit shows it. */
const edits = (line: string): AgentJournalItemBody => ({
  kind: 'tool-call',
  name: 'Edit',
  input: { file_path: MEMORY, new_string: line },
  state: 'completed'
})

function bot(memory: string) {
  const files = new Map([[MEMORY, memory]])
  let beforeReplace = (): void => {}
  let afterMemoryRead: (() => Promise<void>) | undefined
  let failing = 0
  const fs = {
    readText: async (path: string) => {
      const text = files.get(path) ?? null
      if (path === MEMORY && afterMemoryRead) {
        const run = afterMemoryRead
        afterMemoryRead = undefined
        await run()
      }
      return text
    },
    replaceText: async (path: string, expected: string, text: string) => {
      beforeReplace()
      if (failing > 0) {
        failing -= 1
        return false
      }
      if (files.get(path) !== expected) {
        return false
      }
      files.set(path, text)
      return true
    },
    writeText: async (path: string, text: string, options?: { exclusive?: boolean }) => {
      if (options?.exclusive && files.has(path)) {
        return false
      }
      files.set(path, text)
      return true
    }
  }
  const journals = new Map<string, AgentJournalRenderItem[]>()
  const record = createBotMemoryRecord(fs)
  const context = createBotTurnContext(
    fs,
    undefined,
    {
      sourcesAfter: async (sessionId, after) =>
        botMemorySourcesOf(
          (journals.get(sessionId) ?? [])
            .filter((item) => after === null || item.sequence > after)
            .map(({ body }) => body)
        ),
      turnRanSince: async (sessionId, opened) =>
        (journals.get(sessionId) ?? []).some(
          ({ body }) =>
            body.kind === 'turn' &&
            (body.state === 'running' || opened === null || (body.completedAt ?? opened) >= opened)
        )
    },
    undefined,
    record
  )
  const notes: string[] = []
  const conversation = (sessionId: string) => {
    context.launched(
      sessionId,
      'bot-1',
      FOLDER,
      { soul: 'Be brief.', memory },
      true,
      HELD_BOT_RULES
    )
    const journal: AgentJournalRenderItem[] = []
    journals.set(sessionId, journal)
    const show = (bodies: AgentJournalItemBody[]): void => {
      for (const body of bodies) {
        journal.push({
          itemId: `${sessionId}-${journal.length}`,
          revision: 1,
          sequence: journal.length + 1,
          observedAt: 1,
          body
        })
      }
    }
    return {
      /** A turn start: what its agent is sent, now given. */
      started: async () => {
        context.handedOver?.(sessionId, said('go'))
        const plan = await context.plan(sessionId, said('go'))
        plan?.given(TAKEN)
        return plan?.text ?? null
      },
      /** An attachment turn takes its outside context before the provider sees the payload. */
      startedAttachment: async () => {
        context.handedOver?.(sessionId, said('see attached'))
        const plan = await context.launchUpdate?.(sessionId)
        plan?.given(TAKEN)
        return plan?.text ?? null
      },
      /** A prompt command opens its turn with nothing ahead of it. */
      startedCommand: () => context.handedOver?.(sessionId, said('/review')),
      /** Rows of a turn still running. */
      running: show,
      /** Rows the conversation shows, then the end of what ran (one turn or a queued batch). */
      ended: async (...bodies: AgentJournalItemBody[]) => {
        show(bodies)
        context.turnEnded?.(
          sessionId,
          `t${journal.length}`,
          async () => ({ items: journal, openerIds: new Map() }),
          async (_id, body) => void notes.push(`${sessionId}: ${body.text}`)
        )
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }
  }
  return {
    conversation,
    notes,
    read: () => files.get(MEMORY) ?? '',
    write: (text: string) => files.set(MEMORY, text),
    remove: () => files.delete(MEMORY),
    /** Forget, as Settings runs it, or as a chat's own `orca bot memory forget` does. */
    forget: (fact: string, sessionId?: string) =>
      record.forget(
        'bot-1',
        FOLDER,
        fact,
        sessionId ? { kind: 'bot', sessionId } : { kind: 'owner' }
      ),
    afterNextMemoryRead: (run: () => Promise<void>) => (afterMemoryRead = run),
    onReplace: (run: () => void) => (beforeReplace = run),
    failReplaces: (count: number) => (failing = count)
  }
}

const DANA = 'Slack, Dana <https://app.slack.com/client/T1/C1>'
const sources = (text: string) =>
  parseBotMemoryFacts(text).map(({ text: fact, source }) => [fact, source])

describe('where memories came from', () => {
  it("a run's message names its source, and the chat notes that memory changed", async () => {
    const { conversation, notes, read, write } = bot('- 2026-10-01 owner fact\n')
    const chat = conversation('s1')
    await chat.started()
    write('- 2026-10-31 deploys at noon\n- 2026-10-01 owner fact\n')
    await chat.ended(said('[Orca event]', { memorySource: 'Webhook deploys' }), edits('x'))

    expect(read()).toBe(
      '- 2026-10-31 deploys at noon · from: Webhook deploys\n- 2026-10-01 owner fact\n'
    )
    expect(notes).toEqual(['s1: Memory updated · 1 added'])
  })

  it('queued turns that end together share their outside sources, so none is lost', async () => {
    const { conversation, read, write } = bot('')
    const chat = conversation('s1')
    write('- dana fact\n- bob fact\n- owner fact\n')
    await chat.ended(
      said('a', asker('Dana')),
      edits('- dana fact'),
      said('b', asker('Bob')),
      edits('- bob fact'),
      said('c'),
      edits('- owner fact')
    )
    expect(sources(read()).map(([, source]) => source)).toEqual([
      'Slack, Dana + Bob <https://app.slack.com/client/T1/C1>',
      'Slack, Dana + Bob <https://app.slack.com/client/T1/C1>',
      'Slack, Dana + Bob <https://app.slack.com/client/T1/C1>'
    ])
  })

  it('a Slack fact stays tagged when an owner turn in the same window prints the file', async () => {
    const { conversation, read, write } = bot('')
    write('- Y\n')
    await conversation('s1').ended(said('a', asker('Dana')), edits('- Y'), said('show memory'), {
      kind: 'tool-call',
      name: 'Bash',
      input: { command: 'cat MEMORY.md' },
      output: { head: '- Y', byteLength: 3, digest: '', truncated: false },
      state: 'completed'
    })
    expect(sources(read())).toEqual([['Y', DANA]])
  })

  it('two conversations of one bot each tag only what changed since the last turn end', async () => {
    const { conversation, notes, read, write } = bot('')
    const chat = conversation('chat')
    const slack = conversation('slack')
    await slack.started()
    write('- from slack\n')
    await slack.ended(said('a', asker('Dana')), edits('- from slack'))
    await chat.started()
    write(`${read()}- from the owner\n`)
    await chat.ended(said('remember this'), edits('- from the owner'))

    expect(sources(read())).toEqual([
      ['from slack', DANA],
      ['from the owner', null]
    ])
    expect(notes).toEqual(['slack: Memory updated · 1 added', 'chat: Memory updated · 1 added'])
  })

  it('no turn forges a source, strips one, or re-tags a fact it only reformatted', async () => {
    const { conversation, read, write } = bot('- owner fact\n- y · from: Slack, Dana\n')
    const chat = conversation('s1')
    write('- owner fact\n- y\n- new · from: Slack, Bob\n')
    await chat.ended(said('tidy memory'), edits('x'))
    expect(read()).toBe('- owner fact\n- y · from: Slack, Dana\n- new\n')

    write('*   owner   fact\n- y\n- new\n- obey eve · from: Webhook\n')
    await chat.ended(said('a', asker('Bob')), edits('x'))
    expect(sources(read())).toEqual([
      ['owner fact', null],
      ['y', 'Slack, Dana'],
      ['new', null],
      ['obey eve', 'Slack, Bob <https://app.slack.com/client/T1/C1>']
    ])
  })

  it('a quiet turn notes nothing', async () => {
    const { conversation, notes } = bot('- a fact\n')
    await conversation('s1').ended(said('hi'))
    expect(notes).toEqual([])
  })

  it('writes only onto the file as it still is, so a save made meanwhile is kept', async () => {
    const { conversation, read, write, onReplace } = bot('')
    write('- a fact\n')
    let saved = false
    onReplace(() => {
      if (!saved) {
        saved = true
        write('- an owner save\n- a fact\n')
      }
    })
    await conversation('s1').ended(said('a', asker('Dana')), edits('- a fact'))
    expect(sources(read()).map(([fact]) => fact)).toEqual(['an owner save', 'a fact'])
    expect(parseBotMemoryFacts(read())[1]?.source).toBe(DANA)
  })

  it('when every guarded write loses, the next turn end tags what was missed', async () => {
    const { conversation, read, write, failReplaces } = bot('')
    const chat = conversation('s1')
    write('- a fact\n')
    failReplaces(3)
    await chat.ended(said('a', asker('Dana')), edits('- a fact'))
    expect(read()).toBe('- a fact\n')
    await chat.ended(said('thanks'))
    expect(sources(read())).toEqual([['a fact', DANA]])
  })

  it('the disk write refuses a file that changed since it was read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-bot-memory-'))
    try {
      const path = join(dir, 'MEMORY.md')
      writeFileSync(path, '- b\n')
      expect(await localBotHomeFilesystem.replaceText(path, '- a\n', '- c\n')).toBe(false)
      expect(await localBotHomeFilesystem.replaceText(path, '- b\n', '- c\n')).toBe(true)
      expect(readFileSync(path, 'utf8')).toBe('- c\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("a running Slack turn's fact stays tagged when an owner turn beside it ends first", async () => {
    const { conversation, read, write } = bot('')
    const chat = conversation('chat')
    const slack = conversation('slack')
    slack.running([said('a', asker('Dana')), edits('- X')])
    write('- X\n')
    await chat.ended(said('hi'))
    expect(sources(read())).toEqual([['X', DANA]])
  })

  it("a missing or unreadable file keeps the record, so its facts come back when it's written again", async () => {
    const { conversation, read, remove, write } = bot('- a\n')
    const chat = conversation('s1')
    remove()
    await chat.ended(said('forget everything'))
    write('- x\n')
    await chat.ended(said('a', asker('Dana')), edits('- x'))
    expect(sources(read())).toEqual([
      ['a', null],
      ['x', DANA]
    ])
  })
})

describe('two conversations writing one MEMORY.md', () => {
  const OLD = '# Memory\n- 2026-11-01 owner fact\n'
  const TUESDAY = '- 2026-11-06 releases go out Tuesdays'
  /** A whole-file rewrite from a shell, which no edit card shows. */
  const shellWrite: AgentJournalItemBody = {
    kind: 'tool-call',
    name: 'shell',
    input: { command: 'python3 -c \'open("MEMORY.md","w").write(...)\'' },
    state: 'completed'
  }

  it('puts back a fact another chat added when a shell rewrite drops it', async () => {
    const { conversation, read, write } = bot(OLD)
    const release = conversation('release')
    const review = conversation('review')
    await review.ended(said('hi'))
    write(`# Memory\n${TUESDAY}\n- 2026-11-01 owner fact\n`)
    await release.ended(said('remember releases go out Tuesdays'), edits(TUESDAY))
    write('# Memory\n- 2026-11-06 reviews want two approvals\n- 2026-11-01 owner fact\n')
    await review.ended(said('remember reviews want two approvals'), shellWrite)

    expect(read()).toBe(
      `# Memory\n${TUESDAY}\n- 2026-11-06 reviews want two approvals\n- 2026-11-01 owner fact\n`
    )
  })

  it('puts it back however much of the file the rewriting chat had been given', async () => {
    const lines = Array.from({ length: 201 }, (_, index) => `- 2026-11-01 fact ${index + 1}`)
    const { conversation, read, write } = bot(`${lines.join('\n')}\n`)
    const chat = conversation('chat')
    // The launch quoted the first 200 lines; a rewrite of those drops the 201st.
    write(`${lines.slice(0, 200).join('\n')}\n`)
    await chat.ended(said('tidy memory'), shellWrite)

    expect(read()).toBe(`${lines.join('\n')}\n`)
  })

  it('keeps a fact out once Forget took it, from Settings or the bot, even mid-turn', async () => {
    const { conversation, forget, read, write } = bot(OLD)
    const release = conversation('release')
    const review = conversation('review')
    write(`# Memory\n${TUESDAY}\n- 2026-11-01 owner fact\n`)
    await release.ended(said('remember releases go out Tuesdays'), edits(TUESDAY))
    review.running([said('remember reviews want two approvals')])
    write(
      `# Memory\n${TUESDAY}\n- 2026-11-06 reviews want two approvals\n- 2026-11-01 owner fact\n`
    )
    expect(await forget('releases go out Tuesdays')).toBe(true)
    await review.ended(edits('reviews'))

    expect(read()).toBe(
      '# Memory\n- 2026-11-06 reviews want two approvals\n- 2026-11-01 owner fact\n'
    )
    expect(await forget('releases go out Tuesdays')).toBe(false)
  })

  it('a Forget whose write keeps losing fails and leaves the fact recorded', async () => {
    const { conversation, failReplaces, forget, read, write } = bot(`# Memory\n${TUESDAY}\n`)
    const chat = conversation('chat')
    failReplaces(3)
    await expect(forget('releases go out Tuesdays')).rejects.toThrow('MEMORY.md kept changing')
    write('# Memory\n')
    await chat.ended(said('tidy'), shellWrite)

    expect(read()).toBe(`# Memory\n${TUESDAY}\n`)
  })

  it('a Forget before the first launch is not undone by what that launch read', async () => {
    const { conversation, forget, read } = bot(`# Memory\n${TUESDAY}\n`)
    const forgetting = forget('releases go out Tuesdays')
    const chat = conversation('chat')
    expect(await forgetting).toBe(true)
    await chat.ended(said('hi'))

    expect(read()).toBe('# Memory\n')
  })

  it('a Forget before the first launch still records the rest of the file', async () => {
    const lines = Array.from({ length: 201 }, (_, index) => `- 2026-11-01 fact ${index + 1}`)
    const { conversation, forget, read, write } = bot(`${lines.join('\n')}\n- forget this\n`)
    expect(await forget('forget this')).toBe(true)
    const chat = conversation('chat')
    write(`${lines.slice(0, 200).join('\n')}\n`)
    await chat.ended(said('tidy memory'), shellWrite)

    expect(read()).toBe(`${lines.join('\n')}\n`)
  })

  it('a failed Forget before the first launch leaves the launch to start the record', async () => {
    const { conversation, failReplaces, forget, read, write } = bot(`# Memory\n${TUESDAY}\n`)
    failReplaces(3)
    await expect(forget('releases go out Tuesdays')).rejects.toThrow('MEMORY.md kept changing')
    const chat = conversation('chat')
    write('# Memory\n')
    await chat.ended(said('tidy'), shellWrite)

    expect(read()).toBe(`# Memory\n${TUESDAY}\n`)
  })
})

describe('a chat hears of MEMORY.md edited outside it', () => {
  const OLD = '# Memory\n- 2026-11-01 owner fact\n'
  const ADDED = '- 2026-11-09 deploys freeze on Fridays'
  const shellAppend: AgentJournalItemBody = {
    kind: 'tool-call',
    name: 'Bash',
    input: { command: `cat >> MEMORY.md <<'EOF'\n${ADDED}\nEOF` },
    state: 'completed'
  }
  const OUTSIDE = 'changed outside this chat'

  it("not after the bot's own shell append, from its first turn on", async () => {
    const { conversation, read, write } = bot(OLD)
    const chat = conversation('s1')
    expect(await chat.started()).not.toContain('MEMORY.md')
    write(`${read()}${ADDED}\n`)
    await chat.ended(said('remember the Friday freeze'), shellAppend)
    expect(await chat.started()).toBeNull()
    write(`${read()}- 2026-11-09 second fact\n`)
    await chat.ended(shellAppend)

    expect(await chat.started()).toBeNull()
  })

  it("after another chat's edit while its own turn was still running", async () => {
    const { conversation, read, write } = bot(OLD)
    const chat = conversation('s1')
    const other = conversation('s2')
    await chat.started()
    other.running([said('remember the freeze'), { kind: 'turn', turnId: 'o1', state: 'running' }])
    write(`${read()}${ADDED}\n`)
    await chat.ended(said('what do you know?'), shellAppend)

    expect(await chat.started()).toContain(OUTSIDE)
  })

  it("after another chat's edit beside its own explicit edit", async () => {
    const { conversation, read, write } = bot(OLD)
    const chat = conversation('s1')
    const other = conversation('s2')
    await chat.started()
    await chat.ended(said('hi'))
    await chat.started()
    other.running([said('remember the freeze'), { kind: 'turn', turnId: 'o1', state: 'running' }])
    write(`${read()}- 2026-11-09 own fact\n`)
    write(`${read()}${ADDED}\n`)
    await chat.ended(said('remember my fact'), edits('- 2026-11-09 own fact'))

    expect(await chat.started()).toContain(ADDED)
  })

  it('delivers a hand edit on an attachment turn before its tool runs', async () => {
    const { conversation, read, write } = bot(OLD)
    const chat = conversation('s1')
    await chat.started()
    await chat.ended(said('hi'))
    write(`${read()}${ADDED}\n`)
    expect(await chat.startedAttachment()).toContain(ADDED)
    await chat.ended(said('see attached'), {
      kind: 'tool-call',
      name: 'Read',
      input: { file_path: 'notes.png' },
      state: 'completed'
    })

    expect(await chat.started()).toBeNull()
  })

  it('delivers a Settings removal made while an attachment turn was opening', async () => {
    const { conversation, read, write, forget, afterNextMemoryRead } = bot(OLD)
    const chat = conversation('s1')
    write(`${read()}${ADDED}\n`)
    afterNextMemoryRead(async () => {
      expect(await forget('owner fact')).toBe(true)
    })

    expect(await chat.startedAttachment()).toContain(ADDED)
    await chat.ended(said('see attached'), edits(ADDED))

    expect(await chat.started()).toContain('Removed:\n<<<\n- 2026-11-01 owner fact\n>>>')
  })

  it('after a hand edit between turns, though a command turn that did not carry it ran a tool', async () => {
    const { conversation, read, write } = bot(OLD)
    const chat = conversation('s1')
    await chat.started()
    await chat.ended(said('hi'))
    write(`${read()}${ADDED}\n`)
    chat.startedCommand()
    await chat.ended(said('/review'), {
      kind: 'tool-call',
      name: 'Read',
      input: { file_path: 'notes.md' },
      state: 'completed'
    })

    expect(await chat.started()).toContain(ADDED)
  })

  it("after another chat's turn that ended during its own", async () => {
    const { conversation, read, write } = bot(OLD)
    const chat = conversation('s1')
    const other = conversation('s2')
    await chat.started()
    await other.started()
    write(`${read()}${ADDED}\n`)
    await other.ended(said('remember the freeze'), shellAppend)
    write(`${read()}- 2026-11-09 own fact\n`)
    await chat.ended(said('remember my fact'), shellAppend)

    expect(await chat.started()).toContain(ADDED)
  })

  it('not after its own Forget and replacement line, the way the preamble replaces a fact', async () => {
    const { conversation, forget, read, write } = bot(OLD)
    const chat = conversation('s1')
    await chat.started()
    await chat.ended(said('hi'))
    await chat.started()
    const forgetCommand: AgentJournalItemBody = {
      kind: 'tool-call',
      name: 'Bash',
      input: { command: 'orca bot memory forget --fact "owner fact"' },
      state: 'completed'
    }
    expect(await forget('owner fact', 's1')).toBe(true)
    write(`${read()}- 2026-11-09 owner fact, revised\n`)
    await chat.ended(
      said('that fact changed'),
      forgetCommand,
      edits('- 2026-11-09 owner fact, revised')
    )

    expect(await chat.started()).toBeNull()
  })

  it("after another chat's Forget while its turn ran", async () => {
    const { conversation, forget, read, write } = bot(OLD)
    const chat = conversation('s1')
    conversation('s2')
    await chat.started()
    write(`${read()}${ADDED}\n`)
    expect(await forget('owner fact', 's2')).toBe(true)
    await chat.ended(said('remember the freeze'), shellAppend)

    expect(await chat.started()).toContain(OUTSIDE)
  })

  it('after a Forget from Settings while its turn ran', async () => {
    const { conversation, forget, read, write } = bot(OLD)
    const chat = conversation('s1')
    await chat.started()
    write(`${read()}${ADDED}\n`)
    expect(await forget('owner fact')).toBe(true)
    await chat.ended(said('remember the freeze'), shellAppend)

    const sent = await chat.started()
    expect(sent).toContain(OUTSIDE)
    // Forgotten: told as removed, never as a fact it still has.
    expect(sent).toContain('Removed:\n<<<\n- 2026-11-01 owner fact\n>>>')
  })
})

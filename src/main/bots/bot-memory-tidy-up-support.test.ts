import { describe, expect, it, vi } from 'vitest'
import { applyBotMemoryChange, botMemoryDate } from '../../shared/bot-memory-lines'
import { lookAroundSupported } from '../../shared/bots/bot-look-around'
import { tidyUpSupported } from '../../shared/bots/bot-tidy-up'
import { makeTestBot } from './bot.test-fixture'
import type { BotLookState } from './bot-look-around-state'
import { tidyNowRefusal } from './bot-memory-tidy-up'
import { BotTidyUpRunner } from './bot-memory-tidy-up-runner'

describe('tidyUpSupported vs lookAroundSupported', () => {
  it('enables Tidy-up for Antigravity while keeping Look around restricted to Claude and Codex', () => {
    expect(tidyUpSupported('antigravity')).toBe(true)
    expect(tidyUpSupported('claude')).toBe(true)
    expect(tidyUpSupported('codex')).toBe(true)
    expect(tidyUpSupported('cursor')).toBe(false)

    expect(lookAroundSupported('antigravity')).toBe(false)
    expect(lookAroundSupported('claude')).toBe(true)
    expect(lookAroundSupported('codex')).toBe(true)
  })

  it('allows tidyNowRefusal for an active idle Antigravity bot and refuses unsupported agents', () => {
    expect(
      tidyNowRefusal(makeTestBot({ agent: 'antigravity' }), { running: false, busy: false })
    ).toBeNull()
    expect(tidyNowRefusal(makeTestBot({ agent: 'cursor' }), { running: false, busy: false })).toBe(
      'unsupported'
    )
    expect(
      tidyNowRefusal(makeTestBot({ agent: 'antigravity', paused: true }), {
        running: false,
        busy: false
      })
    ).toBe('paused')
    expect(
      tidyNowRefusal(makeTestBot({ agent: 'antigravity' }), { running: true, busy: false })
    ).toBe('running')
    expect(
      tidyNowRefusal(makeTestBot({ agent: 'antigravity' }), { running: false, busy: true })
    ).toBe('busy')
  })
})

describe('BotTidyUpRunner for Antigravity bots', () => {
  it('starts a Tidy now run and applies the returned MEMORY.md draft', async () => {
    const bot = makeTestBot({ id: 'agy-bot', agent: 'antigravity' })
    let state: BotLookState = { suggestions: [], dismissals: [], seenAt: 0, runs: [] }
    let currentMemory = '- 2026-11-20 Existing fact\n'
    const startedConversations: { sessionId?: string; text: string }[] = []
    const noted: { botId: string; changes: number }[] = []

    const today = botMemoryDate(new Date(2_000))
    const runner = new BotTidyUpRunner({
      bots: () => [bot],
      store: {
        get: () => state,
        update: (_botId, fn) => {
          const updated = fn(state)
          state = updated.state
          return updated.result
        }
      },
      newChats: async () => [
        { title: 'Home', lines: [{ by: 'owner', text: 'Always reply in concise bullets.' }] }
      ],
      busy: () => false,
      memory: {
        change: async (_botId, _folder, _by, buildChange, beforeWrite) => {
          const change = await buildChange(currentMemory, null)
          await beforeWrite?.(change)
          currentMemory = applyBotMemoryChange(currentMemory, change)
          return change
        },
        history: async () => [
          {
            id: 'hist-1',
            at: 2_000,
            by: { kind: 'tidy-up' },
            change: { added: [], removed: [] },
            undoable: true
          }
        ]
      },
      fs: {
        readText: async () => currentMemory,
        writeText: vi.fn(async () => true),
        replaceText: async () => true,
        makeDirectory: async () => {},
        statFile: async () => null
      },
      memoryFiles: async () => [],
      homeFolder: () => '/tmp/agy-bot',
      sessions: {
        startConversation: async (_bot, input) => {
          startedConversations.push({ sessionId: input.sessionId, text: input.text })
          return { sessionId: input.sessionId!, clientMessageId: 'cm-1', fingerprint: 'fp-1' }
        },
        release: async () => {}
      },
      watchTurns: async () => ({
        next: async () => ({
          outcome: 'success' as const,
          message: [
            'BEGIN MEMORY.md',
            '- 2026-11-20 Existing fact',
            `- ${today} Always reply in concise bullets.`,
            'END MEMORY.md'
          ].join('\n')
        }),
        dispose: () => {}
      }),
      stopTurn: async () => {},
      turnRunning: () => false,
      noteTidied: (_bot, note) => noted.push(note),
      turnOff: async () => {},
      power: {
        settled: () => true,
        checkFullWake: async () => true,
        suspends: () => 0,
        epoch: () => 1,
        awakeNow: () => 2_000,
        wallNow: () => 2_000,
        holdAwake: () => () => {}
      },
      now: () => 2_000
    })

    expect(runner.tidyNow(bot.id)).toEqual({ started: true })
    await vi.waitFor(() => {
      expect(state.tidyUp?.runs[0]?.endedAt).toBe(2_000)
    })

    expect(startedConversations).toHaveLength(1)
    expect(currentMemory).toContain(`- ${today} Always reply in concise bullets.`)
    expect(state.tidyUp?.last?.learned).toEqual(['Always reply in concise bullets.'])
    expect(noted).toEqual([{ botId: 'agy-bot', changes: 1 }])
  })
})

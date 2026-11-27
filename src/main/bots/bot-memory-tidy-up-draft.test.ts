import { describe, expect, it } from 'vitest'
import { applyBotMemoryChange } from '../../shared/bot-memory-lines'
import {
  TIDY_UP_FAILURES,
  TIDY_UP_MAX_FILED,
  TIDY_UP_MAX_NEW_FACTS,
  tidyUpPrompt
} from './bot-memory-tidy-up'
import { applyTidyUpDraft } from './bot-memory-tidy-up-apply'

const fact = (n: number): string => `- 2026-01-${String((n % 28) + 1).padStart(2, '0')} fact ${n}`
const memoryOf = (facts: number[]): string => `${facts.map(fact).join('\n')}\n`
const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from }, (_, at) => from + at)

async function tidy(memory: string, index: string) {
  let file = memory
  const files = new Map<string, string>()
  const deps: Parameters<typeof applyTidyUpDraft>[0] = {
    memory: {
      change: async (_botId, _folder, _by, make, beforeWrite) => {
        const change = await make(file, null)
        await beforeWrite?.(change)
        file = applyBotMemoryChange(file, change)
        return change
      }
    },
    fs: {
      readText: async (path) => files.get(path) ?? null,
      writeText: async (path, text) => {
        files.set(path, text)
        return true
      },
      replaceText: async (path, _expected, text) => {
        files.set(path, text)
        return true
      },
      makeDirectory: async () => {}
    }
  }
  const reply = `BEGIN MEMORY.md\n${index}END MEMORY.md`
  const outcome = await applyTidyUpDraft(deps, {
    botId: 'b',
    folder: '/home',
    memory,
    reply,
    today: '2026-11-22'
  })
  return { outcome, file }
}

describe('nightly memory tidy-up over the line cap', () => {
  const before = memoryOf(range(0, 280))

  it('applies a draft that shortens MEMORY.md even when it stays over the cap', async () => {
    const { outcome, file } = await tidy(before, memoryOf(range(0, 260)))
    expect(outcome).not.toHaveProperty('error')
    expect(file.trimEnd().split('\n')).toHaveLength(260)
  })

  it('still refuses an over-cap draft that is no shorter', async () => {
    const { outcome, file } = await tidy(before, memoryOf([...range(0, 279), 999]))
    expect(outcome).toEqual({ error: TIDY_UP_FAILURES.tooLong, alerted: false })
    expect(file).toBe(before)
  })

  it('refuses an over-cap draft that shrinks only by leaving out undated lines, which stay', async () => {
    const undated = `${range(0, 280)
      .map((n) => `- note ${n}`)
      .join('\n')}\n`
    const { outcome, file } = await tidy(undated, `${undated.split('\n').slice(20).join('\n')}`)
    expect(outcome).toEqual({ error: TIDY_UP_FAILURES.tooLong, alerted: false })
    expect(file).toBe(undated)
  })

  it('applies a draft that keeps each repeated fact once', async () => {
    const twice = memoryOf([...range(0, 140), ...range(0, 140)])
    const { outcome, file } = await tidy(twice, memoryOf(range(0, 140)))
    expect(outcome).not.toHaveProperty('error')
    expect(file.trimEnd().split('\n')).toHaveLength(140)
  })
})

describe('what a tidy-up is told about the limits it is checked against', () => {
  const prompt = (): string =>
    tidyUpPrompt({ memory: fact(0), files: [], chats: [], today: '2026-11-28' })

  it('states the new lines a run may add, which the draft check enforces', () => {
    expect(prompt()).toContain(`at most ${TIDY_UP_MAX_NEW_FACTS} new lines`)
  })

  it('states the lines a run may file, which the draft check enforces', () => {
    expect(prompt()).toContain(`At most ${TIDY_UP_MAX_FILED} lines a night`)
  })
})

describe('a tidy-up that adds more new lines than it may', () => {
  const before = memoryOf(range(0, 3))
  const added = (count: number): string => memoryOf([...range(0, 3), ...range(100, 100 + count)])

  it('names the number it may add, so the owner can tell what went wrong', async () => {
    const { outcome, file } = await tidy(before, added(TIDY_UP_MAX_NEW_FACTS + 1))
    expect(outcome).toEqual({ error: TIDY_UP_FAILURES.tooManyAdded, alerted: false })
    expect(TIDY_UP_FAILURES.tooManyAdded).toContain(String(TIDY_UP_MAX_NEW_FACTS))
    expect(file).toBe(before)
  })

  it('takes a draft that adds exactly the number it may', async () => {
    const { outcome, file } = await tidy(before, added(TIDY_UP_MAX_NEW_FACTS))
    expect(outcome).not.toHaveProperty('error')
    expect(file.trimEnd().split('\n')).toHaveLength(3 + TIDY_UP_MAX_NEW_FACTS)
  })
})

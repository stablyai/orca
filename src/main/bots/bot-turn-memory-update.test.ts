import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  botMemoryTopicsUpdateText,
  botMemoryUpdateText,
  botMemoryKnown,
  readBotMemoryTopics
} from './bot-turn-memory-update'

const facts = (prefix: string, count: number): string[] =>
  Array.from({ length: count }, (_, index) => `- ${prefix}${index}`)

describe("MEMORY.md's change for a running chat", () => {
  it('sends the whole file when a line other than a fact changed beside the facts', () => {
    const text = botMemoryUpdateText(
      '# Old policy\n- alpha\n- stable',
      '# New policy\n- beta\n- stable'
    )
    expect(text).toContain('<<<\n# New policy\n- beta\n- stable\n>>>')
  })

  it('tells a fact that comes into the loaded lines as added, after a resend that loaded only some', () => {
    const old = facts('old', 200).join('\n')
    const grown = [...facts('new', 201), old].join('\n')
    const launched = botMemoryKnown(null, old)
    const resent = botMemoryUpdateText(launched, grown)
    expect(resent).toContain('- new199\n')
    expect(resent).not.toContain('- new200')

    // The agent was given the loaded lines; Forget then removes new0, which brings new200 in.
    const forgotten = grown.split('\n').slice(1).join('\n')
    expect(botMemoryUpdateText(botMemoryKnown(launched, grown), forgotten)).toContain(
      'Added:\n<<<\n- new200\n>>>\nRemoved:\n<<<\n- new0\n>>>'
    )
  })

  it('says nothing when only lines past the loaded ones changed', () => {
    const before = facts('a', 210).join('\n')
    const after = [...facts('a', 205), '- edited past the cap'].join('\n')
    expect(botMemoryUpdateText(botMemoryKnown(null, before), after)).toBeNull()
  })
})

describe('memory topic files for a running chat', () => {
  const topic = (text: string) => ({ fingerprint: text, text })

  it('names a file whose header changed beside a fact, without its lines', () => {
    const text = botMemoryTopicsUpdateText(
      new Map([['policy.md', topic('# Old\n- alpha')]]),
      new Map([['policy.md', topic('# New\n- beta')]])
    )
    expect(text?.split('\n').slice(1)).toEqual(['Changed: memory/policy.md, read it if relevant'])
  })

  it('stays within 3,000 characters with the count of those left out', () => {
    const now = new Map(
      Array.from({ length: 100 }, (_, index) => [
        `${String(index).padStart(3, '0')}${'x'.repeat(230)}.md`,
        topic('')
      ])
    )
    const text = botMemoryTopicsUpdateText(new Map(), now) ?? ''
    expect(text.length).toBeLessThanOrEqual(3_000)
    expect(text).toMatch(/\(\d+ more changed; list memory\/ to see them\)$/)
  })

  it('never reads a file too large to diff', async () => {
    const read: string[] = []
    const topics = await readBotMemoryTopics(
      {
        listNames: async () => ['big.md', 'small.md'],
        statFile: async (path) => ({ size: path.endsWith('big.md') ? 50_000 : 10, mtimeMs: 7 }),
        readText: async (path) => {
          read.push(path)
          return '- small'
        }
      },
      '/home/bot'
    )
    expect(read).toEqual([join('/home/bot', 'memory', 'small.md')])
    expect(topics.get('big.md')).toEqual({ fingerprint: '50000:7', text: null })
  })
})

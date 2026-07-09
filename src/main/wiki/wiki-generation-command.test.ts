import { describe, expect, it } from 'vitest'
import { buildWikiHeadlessArgs } from './wiki-generation-command'

describe('buildWikiHeadlessArgs', () => {
  it('builds the claude headless args', () => {
    expect(buildWikiHeadlessArgs('claude')).toEqual({
      args: ['-p', '--dangerously-skip-permissions'],
      promptViaStdin: true
    })
  })

  it('builds args for codex containing exec', () => {
    const result = buildWikiHeadlessArgs('codex')
    expect(result?.args).toContain('exec')
    expect(result?.promptViaStdin).toBe(true)
  })

  it('returns null for an unsupported agent', () => {
    expect(buildWikiHeadlessArgs('aider')).toBeNull()
  })
})

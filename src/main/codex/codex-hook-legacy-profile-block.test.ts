import { describe, expect, it } from 'vitest'
import { stripLegacyManagedProfileBlock } from './codex-hook-legacy-cleanup'

const START = '# BEGIN ORCA AGENT STATUS HOOKS'
const END = '# END ORCA AGENT STATUS HOOKS'

describe('legacy Codex managed profile block', () => {
  it('strips a well-formed block and keeps the surrounding config', () => {
    const content = `model = "o3"\n\n${START}\n[[hooks]]\nx = 1\n${END}\n\ntail = true\n`
    expect(stripLegacyManagedProfileBlock(content)).toBe('model = "o3"\n\ntail = true\n')
  })

  it('leaves a file with no managed block untouched', () => {
    expect(stripLegacyManagedProfileBlock('model = "o3"\n')).toBe('model = "o3"\n')
  })

  it('rejoins a CRLF config with CRLF', () => {
    const content = `model = "o3"\r\n\r\n${START}\r\n[[hooks]]\r\n${END}\r\n\r\ntail = true\r\n`
    const next = stripLegacyManagedProfileBlock(content)
    expect(next).toBe('model = "o3"\r\n\r\ntail = true\r\n')
    expect(next).not.toMatch(/[^\r]\n/)
  })

  // CodeRabbit on #20148: a stray marker above a complete block must not hide it.
  it('removes a complete block that sits below an orphaned marker', () => {
    const content = `${START}\nstray = 1\n\n${START}\n[[hooks]]\nx = 1\n${END}\n\ntail = true\n`
    const next = stripLegacyManagedProfileBlock(content)
    expect(next).not.toContain('[[hooks]]')
    expect(next).toContain('stray = 1')
    expect(next).toContain('tail = true')
  })

  // #18861: the old strip ran to EOF whenever the end marker was gone.
  it('fails closed when the end marker was hand-deleted', () => {
    const content = `model = "o3"\n${START}\n[[hooks]]\nx = 1\n\n[user.table]\nkeep = "mine"\n`
    expect(stripLegacyManagedProfileBlock(content)).toBe(content)
  })
})

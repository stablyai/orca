import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { openBotToken, sealBotToken } from './slack-installs.js'

describe('bot token sealing', () => {
  it('opens only with the same key and team', () => {
    const key = randomBytes(32)
    const sealed = sealBotToken(key, 'T1', 'xoxb-secret')
    expect(sealed).not.toContain('xoxb')
    expect(openBotToken(key, 'T1', sealed)).toBe('xoxb-secret')
    expect(() => openBotToken(key, 'T2', sealed)).toThrow()
    expect(() => openBotToken(randomBytes(32), 'T1', sealed)).toThrow()
  })
})

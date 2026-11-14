import { describe, expect, it } from 'vitest'
import { externalChromiumCommandArguments } from './external-chromium-command-arguments'

describe('externalChromiumCommandArguments', () => {
  it('leaves cookie delete unmapped because agent-browser can only clear the whole jar', () => {
    expect(externalChromiumCommandArguments('browserCookieDelete', { name: 'sid' })).toBeNull()
  })
})

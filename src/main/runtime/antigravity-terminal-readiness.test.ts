import { describe, expect, it } from 'vitest'
import {
  detectTerminalWaitBlockedReason,
  isKnownReadyPromptPreview
} from './terminal-wait-detection'

const HEADER = 'Antigravity CLI 1.2.0'

describe('Antigravity terminal readiness', () => {
  it('accepts the idle composer without requiring model or account rows', () => {
    expect(isKnownReadyPromptPreview(`${HEADER}\nlogo glyphs   custom provider\n>`)).toBe(true)
  })

  it.each([
    'Signing in...',
    'Loading workspace...',
    'Initializing MCP servers...',
    '> Gemini 3.7 Flash (current)',
    'unexpected startup state'
  ])('fails closed while the last visible row is %j', (row) => {
    expect(isKnownReadyPromptPreview(`${HEADER}\n${row}`)).toBe(false)
  })

  it('treats a last-row spinner as busy even when an older composer remains in the tail', () => {
    expect(isKnownReadyPromptPreview(`${HEADER}\n>\nGenerating...`)).toBe(false)
  })

  it('refreshes a stale trust block after the composer appears without answering it', () => {
    const trust = `${HEADER}\nDo you trust this workspace folder?\n> Yes, I trust this folder`
    expect(detectTerminalWaitBlockedReason(trust)).toBe('agent-trust-workspace')

    const acceptedByUser = `${trust}\n${HEADER}\n>`
    expect(detectTerminalWaitBlockedReason(acceptedByUser)).toBeNull()
    expect(isKnownReadyPromptPreview(acceptedByUser)).toBe(true)
  })
})

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

  it('accepts an idle screen after an agent response with a numbered list', () => {
    expect(isKnownReadyPromptPreview(`${HEADER}\n1. First result\n2. Second result\n>`)).toBe(true)
  })

  it('refuses a model picker drawn after an older composer', () => {
    expect(isKnownReadyPromptPreview(`${HEADER}\n>\nGemini 3.7 Flash (current)`)).toBe(false)
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

  /** Transcribed agy 1.2.7 / Gemini 3.8 Flash on 2026-09-21; account/path scrubbed.
   * Not a byte capture: Windows node-pty/winpty rebuild failed. Replace via agent-pty-transcript-capture.md.
   * Default accept-edits text shares the caret row; bare-caret detection missed readiness. */
  it('accepts the composer when agy paints its edit mode into the caret row', () => {
    const acceptEdits = [
      'Antigravity CLI 1.2.7',
      'redacted@example.com (Google AI Ultra)',
      'Gemini 3.8 Flash (High)',
      '~/workspace/example',
      '> Accept-edits mode: file edits auto-approved (shift+tab to cycle)'
    ].join('\n')
    expect(isKnownReadyPromptPreview(acceptEdits)).toBe(true)
  })

  it('still refuses a menu dialog whose highlighted row merely starts with a caret', () => {
    // Menu selections share the > prefix.
    expect(isKnownReadyPromptPreview(`${HEADER}\n> Yes, I trust this folder`)).toBe(false)
    expect(isKnownReadyPromptPreview(`${HEADER}\n> Gemini 3.8 Flash`)).toBe(false)
    expect(isKnownReadyPromptPreview(`${HEADER}\n> /model  Set a model`)).toBe(false)
  })

  it('refreshes a stale trust block after the composer appears without answering it', () => {
    const trust = `${HEADER}\nDo you trust this workspace folder?\n> Yes, I trust this folder`
    expect(detectTerminalWaitBlockedReason(trust)).toBe('agent-trust-workspace')

    const acceptedByUser = `${trust}\n${HEADER}\n>`
    expect(detectTerminalWaitBlockedReason(acceptedByUser)).toBeNull()
    expect(isKnownReadyPromptPreview(acceptedByUser)).toBe(true)
  })
})

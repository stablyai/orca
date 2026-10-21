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

  /**
   * Provenance: transcribed from a live agy 1.2.7 / Gemini 3.8 Flash session observed through
   * Orca on 2026-09-21, NOT a byte-exact PTY capture — node-pty could not be rebuilt on this
   * Windows host (winpty's GetCommitHash.bat fails under node-gyp), so the recorder in
   * docs/reference/agent-pty-transcript-capture.md was unavailable. The account row and the
   * workspace path are scrubbed per that doc's privacy table. Replace this with a real
   * transcript fixture once a host that can run the recorder is available.
   *
   * What it pins: agy 1.2.7 launches in accept-edits mode by default and paints that mode into
   * the composer row, so a bare-caret-only rule never established readiness and every supervised
   * worker timed out at agent_readiness.
   */
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
    // Guards the widened composer rule: every dialog prefixes its selection with '> '.
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

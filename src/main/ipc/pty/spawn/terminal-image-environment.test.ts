import { describe, expect, it, vi } from 'vitest'
import { applyTerminalImageEnvironment } from './terminal-image-environment'

describe('terminal image advertisement', () => {
  it('clears the protocol inherited by a renderer with inline images disabled', () => {
    const env: Record<string, string> = { ORCA_IMAGE_PROTOCOL: 'kitty' }
    const deletions = ['PATH']
    applyTerminalImageEnvironment(env, deletions, 'codex', false, false)
    expect(env).toEqual({})
    expect(deletions).toEqual(['PATH', 'ORCA_IMAGE_PROTOCOL'])
  })

  it('advertises Kitty without setting a window ID in the Codex pane', () => {
    const env = {}
    applyTerminalImageEnvironment(env, [], 'codex', true, false)
    expect(env).toEqual({ ORCA_IMAGE_PROTOCOL: 'kitty' })

    const explicit = { KITTY_WINDOW_ID: '42' }
    applyTerminalImageEnvironment(explicit, [], 'codex', true, false)
    expect(explicit).toEqual({ ORCA_IMAGE_PROTOCOL: 'kitty', KITTY_WINDOW_ID: '42' })
  })

  it('uses the attached viewer instead of the host window state', () => {
    vi.stubEnv('CLAUDE_CODE_FORCE_TERMINAL_IMAGES', undefined)
    try {
      const desktop = { ORCA_TERMINAL_IMAGE_VIEWER: '1' }
      applyTerminalImageEnvironment(desktop, [], 'claude', undefined, true)
      expect(desktop).toEqual({
        ORCA_IMAGE_PROTOCOL: 'kitty',
        CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1'
      })

      const mobile = { ORCA_TERMINAL_IMAGE_VIEWER: '0' }
      applyTerminalImageEnvironment(mobile, [], 'claude', undefined, false)
      expect(mobile).toEqual({ CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '0' })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

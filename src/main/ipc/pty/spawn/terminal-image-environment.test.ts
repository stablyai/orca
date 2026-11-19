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

  it('uses the attached viewer when the host has no window', () => {
    vi.stubEnv('CLAUDE_CODE_FORCE_TERMINAL_IMAGES', undefined)
    try {
      const desktop = { ORCA_TERMINAL_IMAGE_VIEWER: '1' }
      applyTerminalImageEnvironment(desktop, [], 'claude', undefined, true)
      expect(desktop).toEqual({
        ORCA_IMAGE_PROTOCOL: 'kitty',
        CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '1'
      })

      const mobile = { ORCA_TERMINAL_IMAGE_VIEWER: '0' }
      applyTerminalImageEnvironment(mobile, [], 'claude', undefined, true)
      expect(mobile).toEqual({ CLAUDE_CODE_FORCE_TERMINAL_IMAGES: '0' })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

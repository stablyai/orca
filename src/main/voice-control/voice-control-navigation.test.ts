import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { VOICE_NAVIGATE_VERBS } from '../../shared/voice-control-types'
import { navigateSurfaceForVerb } from './voice-control-navigation'

/**
 * Boundary guard: every surface verb's channel must be one the renderer actually listens
 * on — the preload bridge registers each ui:* listener by name. A renamed or removed
 * channel fails here instead of silently no-op'ing a voice command.
 */
const PRELOAD_BRIDGE = readFileSync(
  join(__dirname, '../../preload/api/ui-bridge-state-and-menu-commands.ts'),
  'utf8'
)

describe('voice navigation surfaces', () => {
  it('every non-agent verb maps to a channel the preload bridge registers', () => {
    for (const verb of VOICE_NAVIGATE_VERBS) {
      if (verb === 'focus-agent') {
        continue
      }
      const surface = navigateSurfaceForVerb(verb)
      expect(
        PRELOAD_BRIDGE.includes(`'${surface.channel}'`),
        `${verb} → ${surface.channel} has no renderer listener`
      ).toBe(true)
    }
  })

  it('covers every declared verb', () => {
    for (const verb of VOICE_NAVIGATE_VERBS) {
      if (verb === 'focus-agent') {
        continue
      }
      expect(navigateSurfaceForVerb(verb).target).toBeTruthy()
      expect(navigateSurfaceForVerb(verb).past).toBeTruthy()
    }
  })
})

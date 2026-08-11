import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TuiAgent } from '../../../src/shared/types'
import { MOBILE_TUI_AGENT_FAVICON_DOMAINS } from '../tasks/mobile-tui-agents'

// Agents that render a hand-authored glyph in MobileAgentIcon and therefore
// never reach the favicon/bundled-asset path.
const GLYPH_AGENT_IDS = new Set<TuiAgent>([
  'claude',
  'claude-agent-teams',
  'codex',
  'pi',
  'omp',
  'aider'
])

const dirname = import.meta.dirname
const assetsDir = path.resolve(dirname, '../../../src/shared/agent-icons')
const assetsModuleSource = readFileSync(path.join(dirname, 'mobile-agent-icon-assets.ts'), 'utf8')

// Why: these agents previously loaded from Google's favicon service, which is
// unreachable in some regions/offline (#8451). Every one that lacks a glyph
// must ship a bundled PNG so the icon renders without a network request.
const agentsNeedingBundledIcon = Object.keys(MOBILE_TUI_AGENT_FAVICON_DOMAINS).filter(
  (id): id is TuiAgent => !GLYPH_AGENT_IDS.has(id as TuiAgent)
)

describe('mobile bundled agent icons', () => {
  it('ships a bundled PNG on disk for every favicon-path agent', () => {
    for (const id of agentsNeedingBundledIcon) {
      expect(existsSync(path.join(assetsDir, `${id}.png`)), `missing bundled icon for ${id}`).toBe(
        true
      )
    }
  })

  it('wires every favicon-path agent into the bundled asset map', () => {
    for (const id of agentsNeedingBundledIcon) {
      expect(assetsModuleSource, `${id} not mapped in mobile-agent-icon-assets.ts`).toContain(
        `agent-icons/${id}.png`
      )
    }
  })
})

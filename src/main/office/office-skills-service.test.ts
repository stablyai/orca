import { describe, expect, it } from 'vitest'
import { parseOfficeSkillCatalog } from './office-skills-service'

// Verbatim shape of `officecli skills list` on 1.0.148 — it prints usage plus two lines and has no
// `--json` mode, so the parser has to tolerate the surrounding prose.
const REAL_OUTPUT = `Usage:
  officecli skills install                Install base SKILL.md to all detected agents
  officecli skills list                   List all available skills

Skills: pptx, word, excel, word-form, morph-ppt, morph-ppt-3d, pitch-deck, academic-paper, data-dashboard, financial-model
Agents: claude, copilot, codex, cursor, windsurf, minimax, opencode, openclaw, nanobot, zeroclaw, hermes, all
`

describe('officecli skill catalogue parsing', () => {
  it('reads both lists out of the tool’s prose', () => {
    const catalog = parseOfficeSkillCatalog(REAL_OUTPUT)
    expect(catalog.skills).toContain('pptx')
    expect(catalog.skills).toContain('financial-model')
    expect(catalog.skills).toHaveLength(10)
    expect(catalog.agents).toContain('claude')
    expect(catalog.agents).toContain('all')
  })

  it('answers empty rather than guessing when the shape moves', () => {
    // An empty catalogue is reported as a failure by the caller, because offering an empty picker
    // would read as "this tool has no skills".
    expect(parseOfficeSkillCatalog('something else entirely')).toEqual({ skills: [], agents: [] })
  })

  it('drops entries that are prose rather than identifiers', () => {
    const catalog = parseOfficeSkillCatalog('Skills: pptx, and some others, word\nAgents: claude')
    expect(catalog.skills).toEqual(['pptx', 'word'])
  })
})

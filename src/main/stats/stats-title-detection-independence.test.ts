// Regression guard for the second half of #10201.
//
// The deleted AgentDetector read OSC titles, and detectAgentStatusFromTitle
// classifies ANY braille/quarter-circle spinner glyph as `working` with no
// agent-name requirement (agent-title-status.ts). That made every spinner TUI —
// `⠋ npm run build`, a progress bar, a REPL — a counted "agent spawned".
//
// Stats now derive sessions from agent-hook transitions only. This test fails if
// title detection is ever wired back into the stats pipeline, which is the only
// way that false positive can return.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const STATS_DIR = join(__dirname)

/** Modules that classify agent status from terminal titles. */
const TITLE_DETECTION_MODULES = [
  'agent-detection',
  'agent-detector',
  'agent-title-status',
  'agent-title-core',
  'osc-title-extraction',
  'osc-title-scan-tail',
  'agent-decorative-title-signature'
]

function statsSourceFiles(): string[] {
  return readdirSync(STATS_DIR).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
}

describe('stats pipeline independence from OSC title detection', () => {
  it('has stats sources to check', () => {
    // Guards the sweep below from silently passing on an empty file list.
    expect(statsSourceFiles()).toContain('collector.ts')
    expect(statsSourceFiles()).toContain('agent-session-transition-recorder.ts')
  })

  it('no stats source imports a title-based agent detector', () => {
    const offenders: string[] = []
    for (const name of statsSourceFiles()) {
      const source = readFileSync(join(STATS_DIR, name), 'utf8')
      for (const line of source.split('\n')) {
        const specifier = /^\s*import\s[\s\S]*?from\s+['"]([^'"]+)['"]/.exec(line)?.[1]
        if (!specifier) {
          continue
        }
        const moduleName = specifier.slice(specifier.lastIndexOf('/') + 1)
        if (TITLE_DETECTION_MODULES.includes(moduleName)) {
          offenders.push(`${name} -> ${specifier}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

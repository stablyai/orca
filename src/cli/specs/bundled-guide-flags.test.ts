import { describe, expect, it } from 'vitest'
import { BUNDLED_SKILL_GUIDES } from '../bundled-skill-guides'
import { validateCommandAndFlags, type CommandSpec } from '../args'
import { COMMAND_SPECS } from './index'

type GuideInvocation = {
  guide: string
  command: string
  flag: string
  snippet: string
}

// Why: guides write examples as `orca ...`, `orca-dev ...`, or the `ORCA` placeholder.
const CLI_INVOCATION = /(?:^|[\s`(])(?:orca|orca-dev|orca-ide|ORCA)\s+([^\n`]*)/g

// Longest path first so `orchestration worker-start` never resolves as `orchestration worker`.
const SPECS_BY_DEPTH: CommandSpec[] = [...COMMAND_SPECS].sort(
  (a, b) => b.path.length - a.path.length
)

function findSpecForInvocation(invocation: string): CommandSpec | undefined {
  return SPECS_BY_DEPTH.find((spec) => {
    const prefix = `${spec.path.join(' ')} `
    return invocation === spec.path.join(' ') || invocation.startsWith(prefix)
  })
}

function collectGuideInvocations(): GuideInvocation[] {
  const found: GuideInvocation[] = []
  for (const guide of BUNDLED_SKILL_GUIDES) {
    for (const match of guide.fullMarkdown.matchAll(CLI_INVOCATION)) {
      const invocation = match[1].trim()
      const spec = findSpecForInvocation(invocation)
      if (!spec) {
        continue
      }
      // Why: a quoted flag value belongs to the nested program (`--command 'codex --model ...'`), not to orca.
      const orcaArgs = invocation.replace(/'[^']*'|"[^"]*"/g, ' ')
      const flags = [...orcaArgs.matchAll(/(?:^|[\s[(])--([a-z][a-z0-9-]*)/g)].map(
        (flag) => flag[1]
      )
      for (const flag of flags) {
        found.push({
          guide: guide.name,
          command: spec.path.join(' '),
          flag,
          snippet: invocation.slice(0, 120)
        })
      }
    }
  }
  return found
}

describe('bundled skill guides', () => {
  const invocations = collectGuideInvocations()

  it('scans the shipped guides for orchestration examples', () => {
    // Why: the flag ratchet below is vacuous if the scanner stops matching guide prose.
    expect(
      invocations.filter((invocation) => invocation.command.startsWith('orchestration ')).length
    ).toBeGreaterThan(20)
  })

  // Why: the guides ship inside the binary, so an example the parser rejects is a shipped defect.
  it('only documents flags the CLI parser accepts', () => {
    const rejected = invocations.filter((invocation) => {
      try {
        validateCommandAndFlags(COMMAND_SPECS, {
          commandPath: invocation.command.split(' '),
          flags: new Map([[invocation.flag, 'placeholder']])
        })
        return false
      } catch {
        return true
      }
    })
    expect(
      rejected.map((entry) => `${entry.guide}: ${entry.command} --${entry.flag} (${entry.snippet})`)
    ).toEqual([])
  })
})

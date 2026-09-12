/**
 * The orchestration skill guide's own command list, parsed out of its Markdown.
 *
 * Two gates read it and must not drift apart: the static contract test here in
 * config/scripts (every documented verb/flag is accepted by the CLI specs) and
 * tests/e2e/orchestration-guide-contract.spec.ts (every documented verb/flag is
 * actually executed against a live runtime, or explicitly excused).
 *
 * `projectDir` is a parameter rather than `import.meta.dirname` because
 * Playwright transpiles specs to CJS, where `import.meta` is a parse error.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export type GuideInvocation = {
  /** Absolute path of the guide file this invocation was read from. */
  source: string
  verb: string
  flags: string[]
}

/** `ORCA` is the guide's placeholder for whichever CLI executable the agent selected. */
const INVOCATION_PATTERN = /ORCA orchestration ([a-z-]+)([^`\n]*)/gu
const FLAG_PATTERN = /(?:^|\s)--([a-z][a-z-]*)/gu

export function orchestrationGuidePaths(projectDir: string = process.cwd()): string[] {
  const referencesDir = join(projectDir, 'skill-guides', 'orchestration', 'references')
  return [
    join(projectDir, 'skill-guides', 'orchestration.md'),
    ...readdirSync(referencesDir)
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map((name) => join(referencesDir, name))
  ]
}

export function readOrchestrationGuideInvocations(
  projectDir: string = process.cwd()
): GuideInvocation[] {
  return orchestrationGuidePaths(projectDir).flatMap((source) => {
    const text = readFileSync(source, 'utf8')
    return [...text.matchAll(INVOCATION_PATTERN)].map((match) => ({
      source,
      verb: match[1] ?? '',
      flags: [...(match[2] ?? '').matchAll(FLAG_PATTERN)].map((flag) => flag[1] ?? '')
    }))
  })
}

/** The unit both gates count: one `verb --flag` string per documented pair. */
export function commandPair(verb: string, flag: string): string {
  return `${verb} --${flag}`
}

export function documentedOrchestrationCommandPairs(
  projectDir: string = process.cwd()
): Set<string> {
  const pairs = new Set<string>()
  for (const invocation of readOrchestrationGuideInvocations(projectDir)) {
    for (const flag of invocation.flags) {
      pairs.add(commandPair(invocation.verb, flag))
    }
  }
  return pairs
}

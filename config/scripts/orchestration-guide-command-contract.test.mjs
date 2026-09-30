import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ORCHESTRATION_COMMAND_SPECS } from '../../src/cli/specs/orchestration'

const projectDir = resolve(import.meta.dirname, '../..')
const guideRoot = join(projectDir, 'skill-guides', 'orchestration')
const guidePaths = [
  join(projectDir, 'skill-guides', 'orchestration.md'),
  ...readdirSync(join(guideRoot, 'references')).map((name) => join(guideRoot, 'references', name))
]

function documentedInvocations() {
  return guidePaths.flatMap((path) => {
    const text = readFileSync(path, 'utf8')
    return [...text.matchAll(/ORCA orchestration ([a-z-]+)([^`\n]*)/gu)].map((match) => ({
      path,
      verb: match[1],
      flags: [...match[2].matchAll(/(?:^|\s)--([a-z][a-z-]*)/gu)].map((flag) => flag[1])
    }))
  })
}

describe('orchestration guide command contract', () => {
  it('documents only orchestration verbs and flags accepted by the CLI specs', () => {
    const specs = new Map(
      ORCHESTRATION_COMMAND_SPECS.map((spec) => [spec.path[1], new Set(spec.allowedFlags)])
    )

    for (const invocation of documentedInvocations()) {
      const allowed = specs.get(invocation.verb)
      expect(allowed, `${invocation.path}: ${invocation.verb}`).toBeDefined()
      for (const flag of invocation.flags) {
        expect(allowed, `${invocation.path}: ${invocation.verb} --${flag}`).toContain(flag)
      }
    }
  })
})

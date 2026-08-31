import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')
const workflow = parse(
  readFileSync(join(projectDir, '.github/workflows/skill-update-roundtrip.yml'), 'utf8')
)

const expectedPaths = [
  'skills/**',
  'resources/skills/**',
  'config/scripts/verify-skill-update-roundtrip.mjs',
  'config/scripts/skill-update-roundtrip-workflow.test.mjs',
  'src/main/skills/skill-freshness-eligibility.ts',
  'src/shared/skill-freshness.ts',
  '.github/workflows/skill-update-roundtrip.yml'
]

describe('skill-update-roundtrip workflow triggers', () => {
  it('uses the same path filter on push to main as on pull_request', () => {
    // Why: GitHub evaluates each event independently. An unfiltered `push` to
    // main started the 13-job matrix on README-only merges; cancelling that
    // run paints the default-branch tip red.
    expect(workflow.on.pull_request.paths).toEqual(expectedPaths)
    expect(workflow.on.push.branches).toEqual(['main'])
    expect(workflow.on.push.paths).toEqual(workflow.on.pull_request.paths)
  })

  it('does not claim a path filter on merge_group that GitHub would ignore', () => {
    expect(workflow.on.merge_group).toBeDefined()
    expect(workflow.on.merge_group?.paths).toBeUndefined()
  })
})

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  RELAY_GITHUB_REPOSITORY,
  RELAY_WORKFLOW_FILE_PREFIX,
  relayRepositoryApiPath,
  relayWorkflowFile
} from './relay-repository.js'

const sourceDir = fileURLToPath(new URL('.', import.meta.url))
const sources = readdirSync(sourceDir)
  .filter((name) => name.endsWith('.ts') && name !== 'relay-repository.ts')
  .map((name) => ({ name, text: readFileSync(`${sourceDir}${name}`, 'utf8') }))

describe('relay repository identity', () => {
  it('builds API paths and workflow filenames from the one repository name', () => {
    expect(relayRepositoryApiPath('actions/runs')).toBe(`repos/${RELAY_GITHUB_REPOSITORY}/actions/runs`)
    expect(relayWorkflowFile('power-relay-staging.yml')).toBe(
      `${RELAY_WORKFLOW_FILE_PREFIX}power-relay-staging.yml`
    )
  })

  // Why: the public-repo copy renames the repository and prefixes every workflow file. Both have to
  // be one edit, so no other module may restate either.
  it('is the only module naming a GitHub repository', () => {
    for (const { name, text } of sources) {
      expect(text, `${name} restates a GitHub repository`).not.toMatch(/stablyai\//)
    }
  })

  it('is the only module naming a workflow file', () => {
    for (const { name, text } of sources) {
      for (const match of text.matchAll(/'([^']*\.yml)'/g)) {
        const file = match[1] ?? ''
        expect(text, `${name} names ${file} outside relayWorkflowFile`).toMatch(
          new RegExp(`relayWorkflowFile\\('${file.replaceAll('.', '\\.')}'\\)`)
        )
      }
    }
  })
})

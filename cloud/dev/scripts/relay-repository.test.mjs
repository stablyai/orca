import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  RELAY_GITHUB_REPOSITORY,
  RELAY_WORKFLOW_FILE_PREFIX,
  readRelayWorkflow,
  relayWorkflowFile,
  relayWorkflowPath,
  relayWorkflowUrl
} from './relay-repository.mjs'

const directory = fileURLToPath(new URL('.', import.meta.url))
// The Relay copy takes the scripts named for it. Everything else stays with the applications.
const relayScripts = readdirSync(directory)
  .filter((name) => name.includes('relay') && name.endsWith('.mjs'))
  .filter((name) => !name.startsWith('relay-repository.'))

test('workflow identity is derived, never restated', () => {
  assert.equal(relayWorkflowFile('deploy-relay-staging.yml'), `${RELAY_WORKFLOW_FILE_PREFIX}deploy-relay-staging.yml`)
  assert.equal(relayWorkflowPath('deploy-relay-staging.yml'), `.github/workflows/${relayWorkflowFile('deploy-relay-staging.yml')}`)
  assert.ok(relayWorkflowUrl('deploy-relay-staging.yml').pathname.endsWith(relayWorkflowPath('deploy-relay-staging.yml')))
  assert.match(readRelayWorkflow('deploy-relay-staging.yml'), /^name:/m)
  assert.match(RELAY_GITHUB_REPOSITORY, /^[\w.-]+\/[\w.-]+$/)
})

// Why: the public-repo copy changes the owning repository, the workflow filenames, and the depth
// this tree sits at. Each has to be one edit here, so no Relay script may restate any of them.
test('no Relay script restates the repository or the workflow directory', () => {
  for (const name of relayScripts) {
    const text = readFileSync(`${directory}${name}`, 'utf8')
    assert.doesNotMatch(text, /stablyai\//, `${name} restates the GitHub repository`)
    assert.doesNotMatch(text, /\.github\/workflows/, `${name} restates the workflow directory`)
  }
})

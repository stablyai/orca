import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const here = new URL('./', import.meta.url)
const action = readFileSync(new URL('action.yml', here), 'utf8')

test('is a node24 JavaScript action with an always-run post step', () => {
  // A composite action has no `post:`, so the lease could never be released on cancel or failure.
  assert.match(action, /^ {2}using: node24$/m)
  assert.doesNotMatch(action, /using: composite/)
  assert.match(action, /^ {2}main: main\.mjs$/m)
  assert.match(action, /^ {2}post: post\.mjs$/m)
  assert.match(action, /^ {2}post-if: always\(\)$/m)
})

test('declares the inputs the wave-chain callers depend on', () => {
  for (const input of ['bucket:', 'object:', 'holder-key:', 'release:']) {
    assert.match(action, new RegExp(`^ {2}${input}$`, 'm'), input)
  }
  assert.match(action, /default: \$\{\{ github\.repository \}\}\/\$\{\{ github\.run_id \}\}/)
  assert.match(action, /default: 'true'/)
})

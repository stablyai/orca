import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'

const here = new URL('./', import.meta.url)
const action = readFileSync(new URL('action.yml', here), 'utf8')
const modules = readdirSync(here).filter((name) => name.endsWith('.mjs'))
const shipped = modules.filter((name) => !name.endsWith('.test.mjs'))

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

test('stays self-contained so it can be duplicated into the public repo', () => {
  assert.deepEqual(
    readdirSync(here).filter((name) => name === 'package.json' || name === 'node_modules'),
    [],
    'the action must run with zero installed dependencies'
  )
  for (const name of modules) {
    const source = readFileSync(new URL(name, here), 'utf8')
    for (const match of source.matchAll(/^import\b[\s\S]*?from '([^']+)'/gm)) {
      const specifier = match[1]
      const local = specifier.startsWith('.')
      assert.ok(
        specifier.startsWith('node:') || (local && !specifier.includes('..')),
        `${name} imports ${specifier}; only node: builtins and same-directory modules are allowed`
      )
    }
  }
})

test('never reaches for the GCE metadata server', () => {
  // Runners have no metadata.google.internal; the fence broker's token path must not be copied.
  for (const name of shipped) {
    const source = readFileSync(new URL(name, here), 'utf8')
    assert.doesNotMatch(source, /metadata\.google\.internal/, name)
  }
})

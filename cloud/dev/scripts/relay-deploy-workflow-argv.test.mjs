import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { parseArguments as parseBlueGreen } from './deploy-relay-blue-green.mjs'
import { parseArguments as parseGceCandidate } from './deploy-relay-gce-candidate.mjs'
import { RELAY_WORKFLOW_DIRECTORY, readRelayWorkflow } from './relay-repository.mjs'

// Every workflow's real argv, literals as written: a flag combination the parser refuses
// (staging's lone --admin-audience once was one) fails here instead of on a release.

const PROJECT = 'orca-test-project'
const DIGEST = `sha256:${'a'.repeat(64)}`

// Shell-expanded values only; anything a workflow writes literally is parsed as written.
const SAMPLES = {
  project: PROJECT,
  image: `relay@${DIGEST}`,
  'predecessor-image-digest': DIGEST,
  'director-cells-json': JSON.stringify([
    { id: 'cell-a', url: 'https://cell-a.example.test', region: 'us-central1', capacityRequests: 10, initiallyEnabled: true }
  ]),
  'regional-placement-secret-version': '3',
  'min-instances': '1',
  'max-instances': '5',
  'prune-revisions': 'false',
  'bootstrap-runtime-identity': 'false',
  'expected-rehome-generation': '4',
  'region-correction-cohort-percent': '10',
  'rehome-audience': 'https://relay.example.test/v1/admin/host-drain',
  'director-origin': 'https://relay.example.test',
  'admin-audience': 'https://relay.example.test/v1/admin/drain',
  'reserve-placement': 'preserve',
  'shadow-seat-feed-cells': 'preserve',
  mode: 'audit'
}

function sample(flag) {
  if (flag in SAMPLES) return SAMPLES[flag]
  if (flag.endsWith('service-account')) return `${flag.slice(0, 20).replace(/-$/, '')}@${PROJECT}.iam.gserviceaccount.com`
  return `sample-${flag}`
}

// Flags a workflow passes through a bash array (`"${name[@]}"`), from every `name=(...)` it
// assigns; parsing them all at once is the widest set that workflow can send.
function arrayArguments(source, name) {
  const flags = []
  for (const match of source.matchAll(new RegExp(`\\b${name}=\\(([^)]*)\\)`, 'g'))) {
    for (const entry of match[1].matchAll(/(--[a-z0-9-]+)\s+("[^"]*"|\S+)/g)) {
      flags.push([entry[1], entry[2].replace(/^"(.*)"$/, '$1')])
    }
  }
  if (flags.length === 0) throw new Error(`no flags assigned to ${name}`)
  return flags
}

function invocations(source, script) {
  const lines = source.split('\n')
  const found = []
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].includes(`dev/scripts/${script}`)) continue
    const argv = []
    let line = lines[index]
    while (line.trimEnd().endsWith('\\')) {
      line = lines[++index]
      const array = /^\s*"\$\{([a-z_]+)\[@\]\}"\s*\\?\s*$/.exec(line)
      if (array) {
        for (const [flag, value] of arrayArguments(source, array[1])) {
          argv.push(flag, value.includes('$') ? sample(flag.slice(2)) : value)
        }
        continue
      }
      const match = /^\s*(--[a-z0-9-]+)\s+(.+?)\s*\\?\s*$/.exec(line)
      if (!match) throw new Error(`unparsed ${script} argument line: ${line.trim()}`)
      const [, flag, raw] = match
      // A trailing `)"` closes the command substitution the invocation sits in.
      const value = raw.replace(/\)"$/, '').replace(/^"(.*)"$/, '$1')
      argv.push(flag, value.includes('$') ? sample(flag.slice(2)) : value)
    }
    found.push(argv)
  }
  return found
}

const SCRIPTS = [
  ['deploy-relay-blue-green.mjs', parseBlueGreen],
  ['deploy-relay-gce-candidate.mjs', parseGceCandidate]
]

for (const [script, parse] of SCRIPTS) {
  test(`every workflow's ${script} argv parses`, () => {
    let count = 0
    for (const file of readdirSync(RELAY_WORKFLOW_DIRECTORY).filter((name) => name.endsWith('.yml'))) {
      for (const argv of invocations(readFileSync(new URL(file, RELAY_WORKFLOW_DIRECTORY), 'utf8'), script)) {
        count++
        assert.doesNotThrow(() => parse(argv), `${file}: ${argv.join(' ')}`)
      }
    }
    assert.ok(count > 0, `no workflow runs ${script}`)
  })
}

test('the production and staging director workflows are among the parsed', () => {
  for (const name of ['deploy-relay-production-director.yml', 'deploy-relay-staging.yml']) {
    assert.equal(invocations(readRelayWorkflow(name), 'deploy-relay-blue-green.mjs').length, 1, name)
  }
})

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { readRelayWorkflow, relayTreePath } from './relay-repository.mjs'

const workflow = readRelayWorkflow('monitor-relay-clock-skew.yml')
const productionTfvars = readFileSync(
  new URL('../../infra/terraform/environments/production.tfvars', import.meta.url),
  'utf8'
)

// The measuring step's `run: |` block, unindented as the runner receives it.
function measureScript() {
  const lines = workflow.split('\n')
  const step = lines.findIndex((line) => line.includes('name: Measure Date-header skew'))
  const start = lines.findIndex((line, index) => index > step && line.trim() === 'run: |') + 1
  assert.ok(step !== -1 && start > 0, 'measuring step not found')
  const end = lines.findIndex(
    (line, index) => index >= start && line.trim() !== '' && !line.startsWith(' '.repeat(10))
  )
  return lines.slice(start, end === -1 ? undefined : end).map((line) => line.slice(10)).join('\n')
}

// Runs the step in a checkout holding `tfvars`, with every cell answering like a fenced one so
// each probe is named without a clock to judge.
function runMonitor(tfvars) {
  const root = mkdtempSync(join(tmpdir(), 'relay-clock-skew-'))
  try {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'curl'), '#!/usr/bin/env bash\nprintf "HTTP/2 404 \\r\\n\\r\\n"\n')
    chmodSync(join(bin, 'curl'), 0o755)
    const environments = join(root, 'cloud', 'infra', 'terraform', 'environments')
    mkdirSync(environments, { recursive: true })
    if (tfvars !== undefined) writeFileSync(join(environments, 'production.tfvars'), tfvars)
    return spawnSync('bash', ['-e', '-c', measureScript()], {
      cwd: join(root, 'cloud'),
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
      encoding: 'utf8'
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('checks out the tfvars the measuring step reads', () => {
  const tfvars = relayTreePath('infra/terraform/environments/production.tfvars')
  assert.ok(workflow.includes(`sparse-checkout: ${tfvars}\n`))
  assert.ok(workflow.includes('sparse-checkout-cone-mode: false\n'))
})

test('probes every cell production.tfvars declares', () => {
  const declared = [
    ...productionTfvars.matchAll(/"production-gce-c\d+"\s*=\s*\{([\s\S]*?)\n {2}\}/g)
  ].map(([, body]) => /\bhostname\s*=\s*"([^"]+)"/.exec(body)?.[1])
  assert.ok(declared.length > 0)
  const result = runMonitor(productionTfvars)
  assert.deepEqual(
    [...result.stdout.matchAll(/^(\S+): not serving/gm)].map(([, cell]) => cell),
    declared
  )
})

test('fails instead of probing nothing when no cell can be read', () => {
  for (const tfvars of [undefined, 'relay_gce_cells = {}\n']) {
    const result = runMonitor(tfvars)
    assert.equal(result.status, 1)
    assert.match(result.stdout, /::error::read no relay cells/)
  }
})

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { parseProductionCapacityCellArguments } from './prepare-relay-production-capacity-canary.mjs'
import { SAME_CAP_CELLS } from './relay-production-same-cap-wave.mjs'
import { readRelayWorkflow } from './relay-repository.mjs'

const workflow = readRelayWorkflow('deploy-relay-production-same-cap-job.yml')
const capacityWorkflow = readRelayWorkflow('deploy-relay-production-capacity-job.yml')

function hostname(cellId) {
  return cellId.slice('production-gce-'.length)
}

// The job resolves cap and region from the cell id before any admin call; run that block alone.
function resolveCellShape(cellId) {
  const start = workflow.indexOf('          TARGET_HOSTNAME="${TARGET_CELL_ID#production-gce-}"')
  assert.notEqual(start, -1, 'the same-cap cell shape block is missing')
  const end = workflow.indexOf('\n          esac\n', start)
  assert.notEqual(end, -1, 'the same-cap cell shape block has no esac')
  const script = workflow.slice(start, end + '\n          esac'.length).replace(/^ {10}/gm, '')
  return spawnSync('bash', [
    '-euo',
    'pipefail',
    '-c',
    `${script}\necho "\${EXPECTED_REGION} \${EXPECTED_HARD_CAP}"`
  ], { env: { ...process.env, TARGET_CELL_ID: cellId }, encoding: 'utf8' })
}

describe('same-cap roll scripts accept every same-cap cell', () => {
  it('parses every wave cell through the same-cap canary allowlist', () => {
    for (const cellId of SAME_CAP_CELLS) {
      for (const mode of ['isolate', 'drain', 'activate']) {
        assert.deepEqual(parseProductionCapacityCellArguments([
          '--director-origin', 'https://relay.onorca.dev',
          '--cell-origin', `https://${hostname(cellId)}.relay.onorca.dev`,
          '--cell-id', cellId,
          '--approved-cells', 'same-cap',
          '--mode', mode
        ]), {
          directorOrigin: 'https://relay.onorca.dev',
          cellOrigin: `https://${hostname(cellId)}.relay.onorca.dev`,
          cellId,
          mode
        })
      }
    }
  })

  it('resolves a cap and region for every wave cell and refuses anything else', () => {
    for (const cellId of SAME_CAP_CELLS) {
      const resolved = resolveCellShape(cellId)
      assert.equal(resolved.status, 0, `${cellId}: ${resolved.stderr}`)
      assert.match(resolved.stdout.trim(), /^(us-central1 1000|asia-east2 3000)$/)
    }
    assert.equal(resolveCellShape('production-gce-c17').status, 1)
    assert.equal(resolveCellShape('production-gce-c30').status, 1)
  })

  it('passes the same-cap allowlist on every canary invocation the job runs', () => {
    const invocations = workflow.split('prepare-relay-production-capacity-canary.mjs').slice(1)
    assert.equal(invocations.length, 4)
    for (const invocation of invocations) {
      const lines = invocation.split('\n')
      const end = lines.findIndex((line) => !line.endsWith('\\'))
      const call = lines.slice(0, end + 1).join(' ')
      assert.match(call, /--approved-cells same-cap/)
      assert.match(call, /--mode (isolate|drain|activate)/)
    }
  })

  it('leaves the US-only capacity job on the default allowlist', () => {
    assert.doesNotMatch(capacityWorkflow, /--approved-cells/)
  })
})

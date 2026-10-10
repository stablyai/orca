import { describe, expect, it } from 'vitest'
import type { RelayFenceBrokerConfig } from './config.js'
import {
  fenceChildEnvironment,
  sourceFenceArguments
} from './fence-operation-runner.js'

const config = {
  project: 'onorca-cloud',
  directorOrigin: 'https://relay.onorca.dev',
  adminAudience: 'https://relay.onorca.dev/v1/admin/drain',
  sourceCellId: 'production-gce-c3',
  runtimeServiceAccount: 'runtime@example.com',
  imageCommit: 'a'.repeat(40),
  terraformDir: 'infra/terraform',
  unobservedConnectionBound: 10,
  connectionCeiling: 600
} as RelayFenceBrokerConfig

describe('fence operation runner', () => {
  it('passes distinct read and mutation identity tokens', () => {
    expect(
      fenceChildEnvironment(
        config,
        'read.token.value',
        'mutation.token.value',
        { PRESERVED: 'yes' }
      )
    ).toMatchObject({
      PRESERVED: 'yes',
      IAC_TOOL: 'terraform',
      ORCA_RELAY_ADMIN_ID_TOKEN: 'read.token.value',
      ORCA_RELAY_FENCE_MUTATION_ID_TOKEN: 'mutation.token.value',
      ORCA_RELAY_FENCE_IMAGE_COMMIT: 'a'.repeat(40)
    })
  })

  it('binds a source fence to deterministic targets and the production var file', () => {
    const args = sourceFenceArguments(config, '/tmp/topology.json', [
      'production-gce-c12',
      'production-gce-c7'
    ])

    expect(args).toEqual(
      expect.arrayContaining([
        '--source-cell-id',
        'production-gce-c3',
        '--target-cell-ids',
        'production-gce-c12,production-gce-c7',
        '--terraform-var-file',
        'environments/production.tfvars',
        '--mode',
        'fence-source'
      ])
    )
  })
})

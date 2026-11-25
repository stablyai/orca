import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { RelayFenceBrokerConfig } from './config.js'
import {
  metadataIdentityToken,
  metadataServiceAccountEmail
} from './google-metadata.js'

const exec = promisify(execFile)
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024
type CompletedFenceRecovery = {
  attemptId: string
  fenceCommit: string
  gceOperation: string
  terraformStateSerial: number
  planObjectGeneration: string
  terraformStateObjectGeneration: string
  terraformStateObjectSha256: string
}

async function run(file: string, args: string[], environment?: NodeJS.ProcessEnv) {
  return await exec(file, args, {
    env: environment,
    maxBuffer: MAX_OUTPUT_BYTES
  })
}

export function fenceChildEnvironment(
  config: RelayFenceBrokerConfig,
  readToken: string,
  mutationToken: string,
  environment: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...environment,
    IAC_TOOL: 'terraform',
    ORCA_RELAY_ADMIN_ID_TOKEN: readToken,
    ORCA_RELAY_FENCE_MUTATION_ID_TOKEN: mutationToken,
    ORCA_RELAY_FENCE_IMAGE_COMMIT: config.imageCommit
  }
}

function relayFenceArguments(
  config: RelayFenceBrokerConfig,
  topologyFile: string,
  targetCellIds: string[]
): string[] {
  return [
    'dev/scripts/deploy-relay-gce-multi-target.mjs',
    '--project',
    config.project,
    '--director-origin',
    config.directorOrigin,
    '--admin-audience',
    config.adminAudience,
    '--topology-file',
    topologyFile,
    '--source-cell-id',
    config.sourceCellId,
    '--target-cell-ids',
    [...targetCellIds].sort().join(','),
    '--unobserved-connection-bound',
    String(config.unobservedConnectionBound),
    '--runtime-service-account',
    config.runtimeServiceAccount,
    '--environment',
    'production',
    '--fence-commit',
    config.imageCommit,
    '--terraform-dir',
    config.terraformDir,
    '--terraform-var-file',
    'environments/production.tfvars',
    '--connection-ceiling',
    String(config.connectionCeiling),
    '--minimum-lease-remaining-ms',
    '600000'
  ]
}

async function runRelayFenceCommand(
  config: RelayFenceBrokerConfig,
  argumentsForTopology: (
    topologyFile: string,
    brokerServiceAccount: string
  ) => string[]
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'orca-relay-fence-operation-'))
  const topologyFile = join(directory, 'topology.json')
  try {
    await run('terraform', [
      `-chdir=${config.terraformDir}`,
      'init',
      '-input=false',
      '-backend-config=backend/production.hcl'
    ])
    const topology = await run('terraform', [
      `-chdir=${config.terraformDir}`,
      'output',
      '-json',
      'relay_gce_cell_deployments'
    ])
    await writeFile(topologyFile, topology.stdout, { mode: 0o600 })
    const brokerToken = await metadataIdentityToken(config.adminAudience)
    const brokerServiceAccount = await metadataServiceAccountEmail()
    const environment = fenceChildEnvironment(
      config,
      brokerToken,
      brokerToken
    )
    await run(
      'node',
      argumentsForTopology(topologyFile, brokerServiceAccount),
      environment
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export function sourceFenceArguments(
  config: RelayFenceBrokerConfig,
  topologyFile: string,
  targetCellIds: string[]
): string[] {
  return [
    ...relayFenceArguments(config, topologyFile, targetCellIds),
    '--mode',
    'fence-source'
  ]
}

export async function runSourceFence(
  config: RelayFenceBrokerConfig,
  targetCellIds: string[]
): Promise<void> {
  await runRelayFenceCommand(config, (topologyFile) =>
    sourceFenceArguments(config, topologyFile, targetCellIds)
  )
}

export async function runTargetSupersession(
  config: RelayFenceBrokerConfig,
  recovery?: CompletedFenceRecovery
): Promise<void> {
  await runRelayFenceCommand(config, (topologyFile, brokerServiceAccount) => {
    const targets = [
      config.failedTargetCellId,
      config.replacementTargetCellId
    ]
    const args = [
      ...relayFenceArguments(config, topologyFile, targets),
      '--failed-target-cell-id',
      config.failedTargetCellId,
      '--replacement-target-cell-id',
      config.replacementTargetCellId,
      '--mode',
      'supersede-target'
    ]
    if (recovery) {
      args.push(
        '--completed-fence-attempt-id',
        recovery.attemptId,
        '--completed-fence-commit',
        recovery.fenceCommit,
        '--completed-fence-operation',
        recovery.gceOperation,
        '--completed-fence-state-serial',
        String(recovery.terraformStateSerial),
        '--completed-fence-plan-generation',
        recovery.planObjectGeneration,
        '--completed-fence-state-generation',
        recovery.terraformStateObjectGeneration,
        '--completed-fence-state-sha256',
        recovery.terraformStateObjectSha256,
        '--fence-broker-service-account',
        brokerServiceAccount
      )
    }
    return args
  })
}

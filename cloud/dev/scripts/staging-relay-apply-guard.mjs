import { execFileSync } from 'node:child_process'

const PROJECT = 'onorca-cloud-staging'
const SQL_INSTANCE = 'orca-cloud-staging-auth-db'
const MIG_PREFIX = 'orca-cloud-staging-relay-gce-'

function defaultGcloud(args) {
  return execFileSync('gcloud', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

export function stagingRelayPowerState(gcloud = defaultGcloud) {
  const sqlActivationPolicy = gcloud([
    'sql',
    'instances',
    'describe',
    SQL_INSTANCE,
    '--project',
    PROJECT,
    '--format=value(settings.activationPolicy)'
  ])
  const groups = JSON.parse(
    gcloud([
      'compute',
      'instance-groups',
      'managed',
      'list',
      '--project',
      PROJECT,
      `--filter=name~'^${MIG_PREFIX}'`,
      '--format=json(name,targetSize)'
    ])
  )
  return { sqlActivationPolicy, groups }
}

export function assertStagingRelayAwake(gcloud = defaultGcloud) {
  const state = stagingRelayPowerState(gcloud)
  const sleepingGroups = state.groups.filter((group) => Number(group.targetSize) !== 1)
  if (
    state.sqlActivationPolicy !== 'ALWAYS' ||
    state.groups.length < 2 ||
    sleepingGroups.length > 0
  ) {
    throw new Error(
      'Staging Relay is asleep or partially awake. Run the Power Relay Staging wake workflow before any staging Terraform apply.'
    )
  }
}

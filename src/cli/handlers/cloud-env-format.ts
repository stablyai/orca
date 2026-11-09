// Human-readable output for `orca cloud env ...`.
import type {
  CloudEnvironmentBuildsData,
  CloudEnvironmentShowData
} from '../../shared/hosted-sandbox/hosted-environment-cli-contract'
import type { HostedEnvironmentBuildView } from '../../shared/hosted-sandbox/hosted-environment-wire'

export function formatOutcome(build: HostedEnvironmentBuildView): string {
  if (build.status === 'succeeded') {
    return `Build #${build.number} succeeded in ${formatDuration(build.durationMs)}.${build.active ? ' It is now the active build.' : ''}`
  }
  if (build.status === 'canceled') {
    return `Build #${build.number} was canceled.`
  }
  if (build.status === 'failed') {
    const step = build.failedStep ? ` at the ${build.failedStep} step` : ''
    return `Build #${build.number} failed${step}: ${build.error ?? 'unknown error'}.`
  }
  return `Build #${build.number} is ${build.status}.`
}

export function formatShow(data: CloudEnvironmentShowData): string {
  const env = data.environment
  const lines = [
    `Environment: ${env.name} (${env.id})`,
    `Sandbox size: ${env.machineSize === 'large' ? 'Large (8 vCPU · 16 GB)' : 'Standard (4 vCPU · 8 GB)'}   Revision: ${env.revision}${data.canAdmin ? '' : '   (read-only: ask an owner or admin to change it)'}`,
    'Repos:',
    ...(env.repos.length > 0
      ? env.repos.map(
          (repo, index) =>
            `  ${repo.url}${repo.defaultBranch ? ` (${repo.defaultBranch})` : ''}${index === 0 ? '  <- install script runs here' : ''}`
        )
      : ['  (none)']),
    `Variables from Cloud secrets (Shared) passed to the install script: ${env.envVarNames.length > 0 ? env.envVarNames.join(', ') : '(none)'}`,
    `Active build: ${data.activeBuild ? describeBuild(data.activeBuild) : '(none)'}`,
    `Latest build: ${data.latestBuild ? describeBuild(data.latestBuild) : '(none)'}`
  ]
  if (data.staleness) {
    lines.push(
      `Freshness: ${describeStaleness(data.staleness.recommendation, data.staleness.configChanged)}`
    )
  }
  lines.push('Install script:')
  lines.push(env.installScript ? indent(env.installScript) : '  (empty)')
  if (data.environments.length > 1) {
    lines.push(
      `Other environments (pick with --env): ${data.environments
        .filter((other) => other.id !== env.id)
        .map((other) => `${other.name} (${other.id})`)
        .join(', ')}`
    )
  }
  return lines.join('\n')
}

function describeStaleness(recommendation: string, configChanged: boolean): string {
  switch (recommendation) {
    case 'no_build':
      return 'no active build yet'
    case 'deps_changed':
      return 'a lockfile changed since the active build; rebuild recommended'
    case 'config_changed':
      return 'the configuration changed since the active build; rebuild recommended'
    case 'image_updated':
      return 'the base image was updated since the active build; rebuild recommended'
    case 'branch_moved':
      return 'the default branch moved since the active build'
    case 'up_to_date':
      return configChanged ? 'configuration changed since the active build' : 'up to date'
    default:
      return 'unknown'
  }
}

function describeBuild(build: HostedEnvironmentBuildView): string {
  const parts = [`#${build.number} ${build.status}`]
  if (build.status === 'failed') {
    parts.push(
      `${build.failedStep ? `at ${build.failedStep}` : ''}${build.error ? ` (${build.error})` : ''}`.trim()
    )
  }
  if (build.durationMs !== null) {
    parts.push(formatDuration(build.durationMs))
  }
  parts.push(new Date(build.createdAt).toISOString())
  parts.push(build.id)
  return parts.filter(Boolean).join('  ')
}

export function formatBuilds(data: CloudEnvironmentBuildsData): string {
  if (data.builds.length === 0) {
    return `${data.environment.name} has no builds yet. Start one with: orca cloud env build --wait`
  }
  const outcomes = data.builds.map((build) =>
    build.status === 'failed'
      ? `failed${build.failedStep ? ` at ${build.failedStep}` : ''}${build.error ? ` (${build.error})` : ''}`
      : build.status
  )
  // Column width from the widest outcome, so a long failure never shifts the columns after it.
  const width = Math.max(...outcomes.map((outcome) => outcome.length))
  const rows = data.builds.map((build, index) => {
    const outcome = outcomes[index]!
    return `${build.active ? '*' : ' '} #${String(build.number).padEnd(4)} ${outcome.padEnd(width)}  ${formatDuration(build.durationMs).padEnd(8)} ${new Date(build.createdAt).toISOString()}  ${build.id}`
  })
  return [`Builds of ${data.environment.name} (newest first, * = active):`, ...rows].join('\n')
}

function formatDuration(ms: number | null): string {
  if (ms === null) {
    return '-'
  }
  const seconds = Math.round(ms / 1000)
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

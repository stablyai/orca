import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  RELAY_REPOSITORY_ROOT,
  relayTreePath,
  relayWorkflowPath
} from './relay-repository.mjs'

const SHA = /^[a-f0-9]{40}$/

// Every file that decides how relay evidence is produced, sealed, verified, and then spent against
// production; identical content across two commits is what makes the older commit's verdict binding.
export const TRUSTED_EVIDENCE_CODE_PATHS = [
  // Produces and seals the 15-minute dry-run evidence.
  relayWorkflowPath('monitor-relay-production.yml'),
  relayWorkflowPath('monitor-relay-production-job.yml'),
  // Download it, verify its authority, and mutate production on it.
  relayWorkflowPath('deploy-relay-production-same-cap.yml'),
  relayWorkflowPath('deploy-relay-production-same-cap-job.yml'),
  relayWorkflowPath('operate-relay-production-rehome.yml'),
  relayWorkflowPath('operate-relay-production-rehome-job.yml'),
  // Sealing, verification, the wave/canary authority, and the path constants below.
  relayTreePath('dev/scripts/relay-evidence-code-provenance.mjs'),
  relayTreePath('dev/scripts/relay-monitor-evidence.mjs'),
  relayTreePath('dev/scripts/relay-production-same-cap-wave.mjs'),
  relayTreePath('dev/scripts/relay-repository.mjs'),
  // Every other script those jobs run against live production.
  relayTreePath('dev/scripts/infra.mjs'),
  relayTreePath('dev/scripts/operate-relay-regional-rehome.mjs'),
  relayTreePath('dev/scripts/prepare-relay-production-capacity-canary.mjs'),
  relayTreePath('dev/scripts/probe-relay-rehome-trust.mjs'),
  relayTreePath('dev/scripts/validate-relay-capacity-plan.mjs'),
  relayTreePath('dev/scripts/verify-relay-capacity-transition.mjs'),
  // The monitor itself and the live preflight recheck, plus anything that changes their behaviour.
  relayTreePath('apps/relay-ops'),
  relayTreePath('package.json'),
  relayTreePath('pnpm-lock.yaml'),
  relayTreePath('pnpm-workspace.yaml'),
  // The Cloud SQL rollout lease every mutation job takes and releases.
  '.github/actions/cloud-sql-rollout-lease'
]

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  if (result.error) throw new Error('relay evidence provenance cannot run git')
  return result
}

/**
 * Accepts evidence sealed at a different commit only when the current commit descends from it and
 * every trusted path is byte-identical, so the verdict provably came from this exact code. Anything
 * git cannot answer (no checkout, unknown commit, shallow clone) fails closed.
 */
export function requireSameEvidenceCode({
  sealedSha,
  currentSha,
  label,
  repositoryRoot = fileURLToPath(RELAY_REPOSITORY_ROOT)
}) {
  if (!SHA.test(sealedSha ?? '') || !SHA.test(currentSha ?? '')) {
    throw new Error(`${label} commit is invalid`)
  }
  if (sealedSha === currentSha) return
  if (git(repositoryRoot, ['rev-parse', '--git-dir']).status !== 0) {
    throw new Error(`${label} commit cannot be compared without a git checkout`)
  }
  for (const sha of [sealedSha, currentSha]) {
    if (git(repositoryRoot, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]).status !== 0) {
      throw new Error(
        `${label} commit ${sha} is unknown to this checkout; check out with fetch-depth: 0`
      )
    }
  }
  const ancestry = git(repositoryRoot, ['merge-base', '--is-ancestor', sealedSha, currentSha])
  if (ancestry.status === 1) {
    throw new Error(`${label} commit ${sealedSha} is not an ancestor of ${currentSha}`)
  }
  if (ancestry.status !== 0) {
    throw new Error(`${label} commit ancestry could not be determined`)
  }
  const diff = git(repositoryRoot, [
    'diff',
    '--name-only',
    sealedSha,
    currentSha,
    '--',
    ...TRUSTED_EVIDENCE_CODE_PATHS
  ])
  if (diff.status !== 0) throw new Error(`${label} commit comparison failed`)
  const changed = diff.stdout.split('\n').filter(Boolean)
  if (changed.length > 0) {
    throw new Error(`${label} code changed after it was sealed: ${changed.join(',')}`)
  }
}

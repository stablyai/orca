import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { TRUSTED_EVIDENCE_CODE_PATHS } from './relay-evidence-code-provenance.mjs'
import {
  RELAY_REPOSITORY_ROOT,
  relayWorkflowPath,
  relayWorkflowUrl
} from './relay-repository.mjs'
import {
  createEvidenceManifest,
  verifyDryRunAuthority,
  verifyMutationEvidence,
  verifyRestoredEvidence
} from './relay-monitor-evidence.mjs'

const now = Date.parse('2026-07-28T12:00:00.000Z')
const provenanceFor = (commitSha) => [
  '--incident-id',
  'relay-123',
  '--run-id',
  '123',
  '--run-attempt',
  '1',
  '--commit-sha',
  commitSha,
  '--mode',
  'dry-run'
]
const provenance = provenanceFor('a'.repeat(40))
const selector = {
  generation: 2,
  membership: {
    existingOnly: ['c1'],
    migrationOnly: ['c2'],
    general: ['c3']
  }
}

async function evidenceDirectory(migrationPolicy = 'strict') {
  const directory = await mkdtemp(join(tmpdir(), 'relay-monitor-evidence-'))
  const state = {
    schemaVersion: 4,
    incidentId: 'relay-123',
    environment: 'production',
    preDrainDryRun: true,
    migrationPolicy,
    recoverySourceCellId: migrationPolicy === 'recover-forward' ? 'c1' : null,
    capacityCellId: migrationPolicy === 'capacity-transition' ? 'c3' : null,
    startedAt: new Date(now - 17 * 60_000).toISOString(),
    durationMinutes: 15,
    intervalMs: 60_000,
    sampleCount: 16,
    windowStartedAt: new Date(now - 16 * 60_000).toISOString(),
    lastSampleAt: new Date(now - 60_007).toISOString(),
    completedAt: new Date(now - 60_000).toISOString(),
    frozenAt: null,
    expectedSelector: selector
  }
  await writeFile(
    join(directory, 'relay-123.state.json'),
    `${JSON.stringify(state)}\n`
  )
  return directory
}

test('creates and verifies exact restart provenance and hashes', async () => {
  const directory = await evidenceDirectory()
  try {
    await createEvidenceManifest(['--directory', directory, ...provenance])
    await assert.doesNotReject(
      verifyRestoredEvidence(['--directory', directory, ...provenance])
    )
    await writeFile(join(directory, 'relay-123.state.json'), '{}\n')
    await assert.rejects(
      verifyRestoredEvidence(['--directory', directory, ...provenance]),
      /hash does not match/
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('requires fresh green evidence and rechecks the live selector', async () => {
  const directory = await evidenceDirectory()
  try {
    await createEvidenceManifest(['--directory', directory, ...provenance])
    const verifyAuthority = () => verifyDryRunAuthority(
      [
        '--directory',
        directory,
        ...provenance,
        '--required-migration-policy',
        'strict'
      ],
      () => now
    )
    await assert.doesNotReject(verifyAuthority())
    const fetchImpl = async (_input, init) => {
      assert.equal(
        new Headers(init.headers).get('authorization'),
        'Bearer aaa.bbb.ccc'
      )
      return Response.json({ selector })
    }
    await assert.doesNotReject(
      verifyMutationEvidence(
        [
          '--directory',
          directory,
          ...provenance,
          '--mutation-mode',
          'execute',
          '--source-cell-id',
          'c1',
          '--director-origin',
          'https://relay.example'
        ],
        { ORCA_RELAY_ADMIN_ID_TOKEN: 'aaa.bbb.ccc' },
        fetchImpl,
        () => now
      )
    )
    const statePath = join(directory, 'relay-123.state.json')
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    state.completedAt = new Date(now - 300_001).toISOString()
    await writeFile(statePath, `${JSON.stringify(state)}\n`)
    await createEvidenceManifest(['--directory', directory, ...provenance])
    await assert.rejects(
      verifyAuthority(),
      /authority is incomplete or stale/
    )
    await assert.rejects(
      verifyMutationEvidence(
        [
          '--directory',
          directory,
          ...provenance,
          '--mutation-mode',
          'execute',
          '--source-cell-id',
          'c1',
          '--director-origin',
          'https://relay.example'
        ],
        { ORCA_RELAY_ADMIN_ID_TOKEN: 'aaa.bbb.ccc' },
        fetchImpl,
        () => now
      ),
      /incomplete or stale/
    )
    state.completedAt = new Date(now - 60_000).toISOString()
    state.lastSampleAt = new Date(now - 120_001).toISOString()
    await writeFile(statePath, `${JSON.stringify(state)}\n`)
    await createEvidenceManifest(['--directory', directory, ...provenance])
    await assert.rejects(
      verifyMutationEvidence(
        [
          '--directory',
          directory,
          ...provenance,
          '--mutation-mode',
          'execute',
          '--source-cell-id',
          'c1',
          '--director-origin',
          'https://relay.example'
        ],
        { ORCA_RELAY_ADMIN_ID_TOKEN: 'aaa.bbb.ccc' },
        fetchImpl,
        () => now
      ),
      /incomplete or stale/
    )
    state.lastSampleAt = new Date(now - 60_007).toISOString()
    state.startedAt = new Date(now - 26 * 60_000 - 1).toISOString()
    await writeFile(statePath, `${JSON.stringify(state)}\n`)
    await createEvidenceManifest(['--directory', directory, ...provenance])
    await assert.rejects(
      verifyAuthority(),
      /authority is incomplete or stale/
    )
    await assert.rejects(
      verifyMutationEvidence(
        [
          '--directory',
          directory,
          ...provenance,
          '--mutation-mode',
          'execute',
          '--source-cell-id',
          'c1',
          '--director-origin',
          'https://relay.example'
        ],
        { ORCA_RELAY_ADMIN_ID_TOKEN: 'aaa.bbb.ccc' },
        fetchImpl,
        () => now
      ),
      /incomplete or stale/
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('later same-cap waves accept evidence aged by predecessor cell rolls', async () => {
  const directory = await evidenceDirectory()
  try {
    const statePath = join(directory, 'relay-123.state.json')
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    const authorityAt = (...waveArgs) => verifyDryRunAuthority(
      [
        '--directory',
        directory,
        ...provenance,
        '--required-migration-policy',
        'strict',
        ...waveArgs.flatMap((waveIndex) => ['--wave-index', waveIndex])
      ],
      () => now
    )
    const ageState = async (ageMs) => {
      state.completedAt = new Date(now - ageMs).toISOString()
      state.lastSampleAt = new Date(now - ageMs - 7).toISOString()
      state.startedAt = new Date(now - ageMs - 17 * 60_000).toISOString()
      state.windowStartedAt = new Date(now - ageMs - 16 * 60_000).toISOString()
      await writeFile(statePath, `${JSON.stringify(state)}\n`)
      await createEvidenceManifest(['--directory', directory, ...provenance])
    }
    // The wave-0 bound in isolation: exactly 5 minutes, flag or no flag.
    await ageState(5 * 60_000)
    await assert.doesNotReject(authorityAt())
    await assert.doesNotReject(authorityAt('0'))
    await ageState(5 * 60_000 + 1)
    await assert.rejects(authorityAt(), /authority is incomplete or stale/)
    await assert.rejects(authorityAt('0'), /authority is incomplete or stale/)
    // One predecessor cell roll (~16 min) exceeds wave 0 but fits wave 1.
    await ageState(17 * 60_000)
    await assert.rejects(authorityAt('0'), /authority is incomplete or stale/)
    await assert.doesNotReject(authorityAt('1'))
    await assert.rejects(authorityAt('4'), /wave index is invalid/)
    await assert.rejects(authorityAt('x'), /wave index is invalid/)
    // Both edges of one predecessor job timeout: 5min + 75min exactly.
    await ageState(80 * 60_000)
    await assert.doesNotReject(authorityAt('1'))
    await ageState(80 * 60_000 + 1)
    await assert.rejects(authorityAt('1'), /authority is incomplete or stale/)
    await assert.doesNotReject(authorityAt('2'))
    // Wave 2 and wave 3 edges: 5min + 2 * 75min and 5min + 3 * 75min exactly.
    await ageState(155 * 60_000)
    await assert.doesNotReject(authorityAt('2'))
    await ageState(155 * 60_000 + 1)
    await assert.rejects(authorityAt('2'), /authority is incomplete or stale/)
    await ageState(230 * 60_000)
    await assert.doesNotReject(authorityAt('3'))
    await ageState(230 * 60_000 + 1)
    await assert.rejects(authorityAt('3'), /authority is incomplete or stale/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('binds migration policies to their exact mutations', async () => {
  const strictDirectory = await evidenceDirectory()
  const recoveryDirectory = await evidenceDirectory('recover-forward')
  const capacityDirectory = await evidenceDirectory('capacity-transition')
  const fetchImpl = async () => Response.json({ selector })
  try {
    await createEvidenceManifest(['--directory', strictDirectory, ...provenance])
    await createEvidenceManifest(['--directory', recoveryDirectory, ...provenance])
    await createEvidenceManifest(['--directory', capacityDirectory, ...provenance])
    await assert.rejects(
      verifyDryRunAuthority(
        [
          '--directory',
          recoveryDirectory,
          ...provenance,
          '--required-migration-policy',
          'strict'
        ],
        () => now
      ),
      /authority is incomplete or stale/
    )
    const verify = (directory, mutationMode, sourceCellId = 'c1') => verifyMutationEvidence(
      [
        '--directory',
        directory,
        ...provenance,
        '--mutation-mode',
        mutationMode,
        '--source-cell-id',
        sourceCellId,
        '--director-origin',
        'https://relay.example'
      ],
      { ORCA_RELAY_ADMIN_ID_TOKEN: 'aaa.bbb.ccc' },
      fetchImpl,
      () => now
    )
    await assert.doesNotReject(verify(strictDirectory, 'execute'))
    await assert.doesNotReject(
      verify(capacityDirectory, 'capacity-transition', 'c3')
    )
    await assert.doesNotReject(verify(recoveryDirectory, 'recover-forward'))
    await assert.doesNotReject(verify(recoveryDirectory, 'fence-source'))
    await assert.doesNotReject(
      verifyMutationEvidence(
        [
          '--directory',
          recoveryDirectory,
          ...provenance,
          '--mutation-mode',
          'execute',
          '--source-cell-id',
          'c12',
          '--scoped-recovery-source-cell-id',
          'c1',
          '--director-origin',
          'https://relay.example'
        ],
        { ORCA_RELAY_ADMIN_ID_TOKEN: 'aaa.bbb.ccc' },
        fetchImpl,
        () => now
      )
    )
    await assert.doesNotReject(
      verifyMutationEvidence(
        [
          '--directory',
          recoveryDirectory,
          ...provenance,
          '--mutation-mode',
          'recover-forward',
          '--source-cell-id',
          'c12',
          '--scoped-recovery-source-cell-id',
          'c1',
          '--director-origin',
          'https://relay.example'
        ],
        { ORCA_RELAY_ADMIN_ID_TOKEN: 'aaa.bbb.ccc' },
        fetchImpl,
        () => now
      )
    )
    await assert.rejects(
      verify(recoveryDirectory, 'execute'),
      /migration policy does not match/
    )
    await assert.rejects(
      verify(strictDirectory, 'recover-forward'),
      /migration policy does not match/
    )
    await assert.rejects(
      verify(strictDirectory, 'capacity-transition', 'c3'),
      /migration policy does not match/
    )
    await assert.rejects(
      verify(capacityDirectory, 'capacity-transition', 'c1'),
      /capacity cell does not match/
    )
    await assert.rejects(
      verifyMutationEvidence(
        [
          '--directory',
          recoveryDirectory,
          ...provenance,
          '--mutation-mode',
          'recover-forward',
          '--source-cell-id',
          'c9',
          '--director-origin',
          'https://relay.example'
        ],
        { ORCA_RELAY_ADMIN_ID_TOKEN: 'aaa.bbb.ccc' },
        fetchImpl,
        () => now
      ),
      /recovery source does not match/
    )
    await assert.rejects(
      verifyMutationEvidence(
        [
          '--directory',
          recoveryDirectory,
          ...provenance,
          '--mutation-mode',
          'fence-source',
          '--source-cell-id',
          'c1',
          '--scoped-recovery-source-cell-id',
          'c1',
          '--director-origin',
          'https://relay.example'
        ],
        { ORCA_RELAY_ADMIN_ID_TOKEN: 'aaa.bbb.ccc' },
        fetchImpl,
        () => now
      ),
      /scoped recovery evidence is invalid/
    )
    await assert.rejects(
      verifyMutationEvidence(
        [
          '--directory',
          recoveryDirectory,
          ...provenance,
          '--mutation-mode',
          'execute',
          '--source-cell-id',
          'c12',
          '--scoped-recovery-source-cell-id',
          'c9',
          '--director-origin',
          'https://relay.example'
        ],
        { ORCA_RELAY_ADMIN_ID_TOKEN: 'aaa.bbb.ccc' },
        fetchImpl,
        () => now
      ),
      /recovery source does not match/
    )
  } finally {
    await rm(strictDirectory, { recursive: true, force: true })
    await rm(recoveryDirectory, { recursive: true, force: true })
    await rm(capacityDirectory, { recursive: true, force: true })
  }
})

test('workflow reruns restore the prior attempt into one stable incident', async () => {
  const workflow = await readFile(
    relayWorkflowUrl('monitor-relay-production-job.yml'),
    'utf8'
  )
  assert.match(workflow, /INCIDENT_ID: relay-\$\{\{ github\.run_id \}\}-\$\{\{ inputs\.mode \}\}/)
  assert.doesNotMatch(workflow, /INCIDENT_ID:.*run_attempt/)
  assert.match(workflow, /actions\/download-artifact@v4/)
  assert.match(workflow, /verify-restore/)
  assert.match(workflow, /RESTART_FLAG=--restart/)
  assert.equal(workflow.match(/--capacity-cell-id/g)?.length, 3)
  const dispatchWorkflow = await readFile(
    relayWorkflowUrl('monitor-relay-production.yml'),
    'utf8'
  )
  assert.match(dispatchWorkflow, /- capacity-transition/)
  assert.match(dispatchWorkflow, /capacity-cell-id: \$\{\{ inputs\.capacity-cell-id \}\}/)
})

test('same-cap and rehome mutations require complete strict dry-run authority', async () => {
  for (const name of [
    'deploy-relay-production-same-cap-job.yml',
    'operate-relay-production-rehome-job.yml'
  ]) {
    const workflow = await readFile(
      relayWorkflowUrl(name),
      'utf8'
    )
    assert.match(workflow, /relay-monitor-evidence\.mjs verify-authority/)
    assert.match(workflow, /--required-migration-policy strict/)
    assert.doesNotMatch(workflow, /relay-monitor-evidence\.mjs verify-restore/)
  }
})

test('production mutation workflows consume and live-recheck dry-run evidence', async () => {
  for (const name of [
    'deploy-relay-production.yml',
    'deploy-relay-production-multi-target.yml'
  ]) {
    const workflow = await readFile(
      relayWorkflowUrl(name),
      'utf8'
    )
    assert.match(workflow, /actions\/download-artifact@v4/)
    assert.match(workflow, /verify-mutation/)
    assert.match(workflow, /--mutation-mode "\$\{DEPLOY_MODE\}"/)
    assert.match(workflow, /--source-cell-id "\$\{SOURCE_CELL_ID\}"/)
    assert.match(workflow, /incident:relay-preflight/)
    assert.match(workflow, /Reject previously consumed dry-run evidence/)
    assert.match(workflow, /actions\/upload-artifact@v4/)
    assert.match(workflow, /relay-monitor-consumed-/)
    assert.match(workflow, /ORCA_RELAY_ADMIN_ID_TOKEN/)
    assert.match(workflow, /github\.ref == 'refs\/heads\/main'/)
    assert.ok(
      workflow.indexOf('pnpm install --frozen-lockfile') <
      workflow.indexOf('id: google-auth')
    )
  }
})

test('monitor and mutation workflows share the production Cloud SQL rollout lock', async () => {
  for (const name of [
    'monitor-relay-production.yml',
    'deploy-relay-production.yml',
    'deploy-relay-production-multi-target.yml',
    'deploy-relay-production-capacity.yml'
  ]) {
    const workflow = await readFile(
      relayWorkflowUrl(name),
      'utf8'
    )
    assert.match(workflow, /group: production-cloud-sql-rollout/)
  }
})

test('monitor uses a reusable job so exact job_workflow_ref is present', async () => {
  const wrapper = await readFile(
    relayWorkflowUrl('monitor-relay-production.yml'),
    'utf8'
  )
  assert.ok(wrapper.includes(`uses: ./${relayWorkflowPath('monitor-relay-production-job.yml')}`))
  const job = await readFile(
    relayWorkflowUrl('monitor-relay-production-job.yml'),
    'utf8'
  )
  assert.match(job, /workflow_call:/)
  assert.match(job, /environment: production/)
})

function gitIn(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
}

// A real repository shaped like main under unrelated merge traffic: one sealed commit, a
// descendant that only touched untrusted files, a descendant that touched the monitor, and a
// sibling that never descended from the seal.
async function trustedCodeRepository() {
  const root = await mkdtemp(join(tmpdir(), 'relay-evidence-repository-'))
  gitIn(root, 'init', '--quiet')
  gitIn(root, 'config', 'user.email', 'relay@example.test')
  gitIn(root, 'config', 'user.name', 'Relay Evidence Test')
  gitIn(root, 'config', 'commit.gpgsign', 'false')
  const commit = async (path, body, message) => {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), body)
    gitIn(root, 'add', '--all')
    gitIn(root, 'commit', '--quiet', '--no-verify', '--message', message)
    return gitIn(root, 'rev-parse', 'HEAD')
  }
  const base = await commit(
    'cloud/apps/relay-ops/src/incident-monitor.ts',
    'export const v = 1\n',
    'monitor'
  )
  const sealed = await commit('README.md', 'base\n', 'base')
  const sameCode = await commit('README.md', 'an unrelated merge\n', 'unrelated')
  const changedCode = await commit(
    'cloud/apps/relay-ops/src/incident-monitor.ts',
    'export const v = 2\n',
    'monitor change'
  )
  // Branches before the seal, so the seal is not in its history even though its code matches.
  gitIn(root, 'checkout', '--quiet', '--detach', base)
  const sibling = await commit('README.md', 'a divergent line\n', 'divergent')
  return { root, sealed, sameCode, changedCode, sibling }
}

const authorityAt = (directory, commitSha, repositoryRoot) => verifyDryRunAuthority(
  [
    '--directory',
    directory,
    ...provenanceFor(commitSha),
    '--required-migration-policy',
    'strict'
  ],
  () => now,
  repositoryRoot
)

test('accepts dry-run evidence sealed by identical code at an ancestor commit', async () => {
  const repository = await trustedCodeRepository()
  const directory = await evidenceDirectory()
  try {
    await createEvidenceManifest([
      '--directory',
      directory,
      ...provenanceFor(repository.sealed)
    ])
    // An exact match never consults git: a root with no checkout at all still verifies.
    await assert.doesNotReject(authorityAt(directory, repository.sealed, directory))
    await assert.doesNotReject(authorityAt(directory, repository.sameCode, repository.root))
  } finally {
    await rm(repository.root, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects dry-run evidence whose monitor code or lineage differs', async () => {
  const repository = await trustedCodeRepository()
  const directory = await evidenceDirectory()
  try {
    await createEvidenceManifest([
      '--directory',
      directory,
      ...provenanceFor(repository.sealed)
    ])
    await assert.rejects(
      authorityAt(directory, repository.changedCode, repository.root),
      /code changed after it was sealed: cloud\/apps\/relay-ops\/src\/incident-monitor\.ts/
    )
    await assert.rejects(
      authorityAt(directory, repository.sibling, repository.root),
      /is not an ancestor of/
    )
    // Fails closed: a shallow clone that never fetched the sealed commit proves nothing.
    await assert.rejects(
      authorityAt(directory, 'f'.repeat(40), repository.root),
      /unknown to this checkout/
    )
    // Fails closed: no checkout to compare against.
    await assert.rejects(
      authorityAt(directory, repository.sameCode, directory),
      /cannot be compared without a git checkout/
    )
  } finally {
    await rm(repository.root, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
})

test('keeps restore and mutation bound to the exact sealing commit', async () => {
  const repository = await trustedCodeRepository()
  const directory = await evidenceDirectory()
  try {
    await createEvidenceManifest([
      '--directory',
      directory,
      ...provenanceFor(repository.sealed)
    ])
    await assert.rejects(
      verifyRestoredEvidence([
        '--directory',
        directory,
        ...provenanceFor(repository.sameCode)
      ]),
      /provenance does not match/
    )
    await assert.rejects(
      verifyMutationEvidence(
        [
          '--directory',
          directory,
          ...provenanceFor(repository.sameCode),
          '--mutation-mode',
          'execute',
          '--source-cell-id',
          'c1',
          '--director-origin',
          'https://relay.example'
        ],
        { ORCA_RELAY_ADMIN_ID_TOKEN: 'aaa.bbb.ccc' },
        async () => Response.json({ selector }),
        () => now
      ),
      /provenance does not match/
    )
  } finally {
    await rm(repository.root, { recursive: true, force: true })
    await rm(directory, { recursive: true, force: true })
  }
})

// A trusted path that no longer exists silently stops being compared, so the same-code rule would
// pass over code it was written to pin.
test('every trusted provenance path exists in this checkout', async () => {
  for (const path of TRUSTED_EVIDENCE_CODE_PATHS) {
    await assert.doesNotReject(
      stat(new URL(path, RELAY_REPOSITORY_ROOT)),
      `${path} is missing`
    )
  }
})

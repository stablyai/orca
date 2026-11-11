import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SshTarget } from '../../../../shared/ssh-types'
import { parseOrcadMigrationManifest } from '../../../../shared/orcad-migration/orcad-migration-manifest-validation'
import { closeTestStores, createSqliteTestStore } from '../../persistence-test-harness'
import { Store } from '../../loading-store/store'

import '../cutover-journals/orcad-migration-cutover-journal'
import '../source/catalog/orcad-migration-manifest-export'
import '../../../ssh/migration-source/orcad-migration-source-assertions'
import { fenceOrcadMigrationSource } from '../../../ssh/migration-source/orcad-migration-source-fence'
import { SshTargetOrcadClaims } from '../../../ssh/targets/ssh-target-orcad-claims'

const TARGET: SshTarget = {
  id: 'ssh-prod',
  label: 'Production',
  host: 'prod.example.com',
  port: 22,
  username: 'deploy',
  generation: 2
}

const directories: string[] = []
afterEach(async () => {
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** A host whose one automation kept more run output than a whole manifest may hold (#37051). */
async function hostWithRunHistory(outputChars = 30_000) {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orcad-run-history-'))
  directories.push(userDataPath)
  const store = createSqliteTestStore(Store, {
    dataFile: join(userDataPath, 'desktop', 'orca-data.json')
  })
  const server = createSqliteTestStore(Store, {
    dataFile: join(userDataPath, 'server', 'orca-data.json')
  })
  store.addSshTarget(TARGET)
  store.addRepo({
    id: 'repo-1',
    path: '/srv/app',
    displayName: 'App',
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git',
    connectionId: TARGET.id
  })
  const automation = store.createAutomation({
    name: 'Nightly check',
    prompt: 'Check the repo',
    agentId: 'claude',
    projectId: 'repo-1',
    workspaceMode: 'new_per_run',
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: 1
  })
  for (let index = 0; index < 40; index++) {
    const run = store.createAutomationRun(automation, 1_000 + index)
    store.updateAutomationRun({
      runId: run.id,
      status: 'completed',
      outputSnapshot: {
        format: 'plain_text',
        content: `run ${index}: ${'x'.repeat(outputChars)}`,
        capturedAt: 2_000 + index,
        truncated: false
      }
    })
  }
  const claims = new SshTargetOrcadClaims(store)
  const fenced = await fenceOrcadMigrationSource({
    userDataPath,
    store,
    claims,
    targetId: TARGET.id,
    destinationEnvironmentId: 'env-1',
    destinationName: 'Managed',
    terminalProof: { verdict: 'exited', provenPtyIds: [] }
  })
  if (fenced.outcome !== 'fenced') {
    throw new Error(`expected a fence: ${fenced.reason}`)
  }
  return { userDataPath, store, server, claims, automation, cutover: fenced.cutover }
}

describe('moving automation run history to a host server', () => {
  it('refuses a commit whose history never arrived, importing nothing', async () => {
    const h = await hostWithRunHistory()
    const manifest = parseOrcadMigrationManifest(JSON.parse(JSON.stringify(h.cutover.manifest)))
    h.server.stageOrcadMigrationCatalog(manifest)

    expect(() => h.server.commitStagedOrcadMigrationCatalog(manifest)).toThrow(
      'orcad_migration_blob_incomplete:automation-run-history:migration'
    )
    expect(h.server.getOrcadMigrationCatalogState(manifest).state).toBe('staged')
    expect(h.server.listAutomations()).toEqual([])
  })
})

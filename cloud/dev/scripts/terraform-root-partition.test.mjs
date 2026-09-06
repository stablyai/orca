import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  DECLARING_ROOTS,
  ENVIRONMENTS,
  ROOTS,
  auditStateList,
  declaredFamilies,
  declaredRootFamilies,
  expectedRootFamilies,
  ownedRootFamilies,
  readPartition,
  rootFor
} from './terraform-root-partition.mjs'

const partition = readPartition()
const declared = new Map(DECLARING_ROOTS.flatMap((root) => [...declaredFamilies(root)].map(([family, file]) => [family, `${root}/${file}`])))

test('every declared resource family is assigned to exactly one root per environment', () => {
  for (const family of declared.keys()) {
    for (const environment of ENVIRONMENTS) {
      const owners = ROOTS.filter((root) => expectedRootFamilies(partition, root, environment).has(family))
      assert.deepEqual(owners, [rootFor(partition, family, environment)], `${family} in ${environment}`)
    }
  }
})

// Only the relay directory ships here, so only the families the partition assigns to a declaring
// root can be checked back against a .tf file. The full listing is still checked for duplicates.
test('the partition names no family that is not declared', () => {
  const listed = [
    ...ROOTS.flatMap((root) => partition[root]),
    ...Object.keys(partition.env_conditional)
  ]
  for (const root of DECLARING_ROOTS) {
    for (const family of ownedRootFamilies(partition, root)) {
      assert.ok(declared.has(family), `${family} is not declared`)
    }
  }
  assert.equal(new Set(listed).size, listed.length, 'a family is listed twice')
})

test('environment-conditional families are owned by different roots per environment', () => {
  for (const [family, owners] of Object.entries(partition.env_conditional)) {
    assert.deepEqual(Object.keys(owners).sort(), [...ENVIRONMENTS].sort(), family)
    assert.notEqual(owners.production, owners.staging, `${family} is not really conditional`)
  }
})

// Why: this is the census that survives the carve. Filename prefixes stopped meaning anything
// once each root became its own directory, so ownership is checked against the directory that
// declares the family. A root declares exactly what it owns in at least one environment; the
// environment-conditional ten are therefore declared twice, once per complementary count.
test('each root declares exactly the families it owns in some environment', () => {
  for (const root of DECLARING_ROOTS) {
    assert.deepEqual(
      [...declaredRootFamilies(root)].sort(),
      [...ownedRootFamilies(partition, root)].sort(),
      root
    )
  }
})

// Why: the removed blocks were a guard for the config-first window between the carve and the two
// state surgeries. Both are done; a removed block that resurfaces would silently turn a stray apply
// from "destroy" into "forget" and hide a real ownership mistake.
test('the carved families are gone from the relay root and nothing is guarded by a removed block', () => {
  const relay = declaredRootFamilies('relay')
  for (const family of [...partition.foundation, ...partition.apps]) {
    assert.ok(!relay.has(family), `${family} is still declared in the relay root`)
  }
  assert.ok(!existsSync(new URL('../../infra/terraform/relay-root-carve-removed.tf', import.meta.url)))
  for (const file of readdirSync(new URL('../../infra/terraform/', import.meta.url))) {
    if (!file.endsWith('.tf')) continue
    const source = readFileSync(new URL(`../../infra/terraform/${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /^removed \{/m, `${file} declares a removed block`)
  }
})

// Why: every binding on the shared deploy account follows that account (relay in production,
// apps in staging). Letting one drift back into foundation recreates the dependency cycle the
// split exists to remove: foundation would need the account while relay needs the pool.
test('foundation owns only what both other roots must be able to bootstrap against', () => {
  assert.deepEqual(partition.foundation, [
    'google_artifact_registry_repository.api',
    'google_iam_workload_identity_pool.github',
    'google_project_service.required',
    'google_project_service.sqladmin',
    'google_service_account.runtime',
    'google_sql_database_instance.auth',
    'google_storage_bucket_iam_member.cloud_sql_rollout_lease',
    'google_storage_bucket_iam_member.cloud_sql_rollout_lease_bucket_reader'
  ])
})

// Why: the two staging orphans were cleared by the runbook; the allowance is empty so a stray
// entry is reported instead of silently tolerated again.
test('audit reports entries outside the partition and no longer tolerates the staging orphans', () => {
  const stateList = [
    'google_project_service.required["run.googleapis.com"]',
    'google_secret_manager_secret_iam_member.runtime_artifact_write_secret_accessor[0]',
    'data.google_compute_image.relay_gce_cos[0]',
    'google_cloud_run_v2_service.relay'
  ].join('\n')
  assert.deepEqual(partition.state_orphans, { staging: [], production: [] })
  const foundation = auditStateList(partition, 'foundation', 'staging', stateList)
  assert.deepEqual(foundation.unexpected, [
    'google_secret_manager_secret_iam_member.runtime_artifact_write_secret_accessor[0]',
    'google_cloud_run_v2_service.relay'
  ])
  const relay = auditStateList(partition, 'relay', 'staging', stateList)
  assert.deepEqual(relay.unexpected, [
    'google_project_service.required["run.googleapis.com"]',
    'google_secret_manager_secret_iam_member.runtime_artifact_write_secret_accessor[0]'
  ])
})

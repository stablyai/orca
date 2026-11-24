import { chmodSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import Database from '../../../sqlite/sync-database'
import { PipelineStore } from '../pipeline-store'
import { pipelineV2AdmissionFixture } from './pipeline-v2.test-fixture'
import { pipelineV2ReviewedFixture } from '../../../../shared/pipelines/v2/pipeline-v2.test-fixture'

it('rolls back the complete additive schema if a later component cannot migrate, then retries safely', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'orca-v2-migration-')), 'pipelines.sqlite')
  const legacy = new Database(path)
  legacy.exec(`CREATE TABLE pipeline_runs (id TEXT PRIMARY KEY, instance_id TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
    CREATE TABLE pipeline_schema (component TEXT PRIMARY KEY, version INTEGER NOT NULL);
    CREATE TRIGGER refuse_library BEFORE INSERT ON pipeline_schema WHEN NEW.component='pipelines-v2-library' BEGIN SELECT RAISE(ABORT, 'test_migration_refused'); END;`)
  legacy
    .prepare('INSERT INTO pipeline_runs VALUES (?,?,?)')
    .run('legacy-run', 'legacy-instance', '{"legacy":true}')
  legacy.close()
  chmodSync(path, 0o600)
  expect(() => new PipelineStore(path)).toThrow('test_migration_refused')
  const preserved = new Database(path)
  try {
    expect(
      preserved
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((row) => row.name)
    ).toEqual(['pipeline_runs', 'pipeline_schema'])
    expect(preserved.prepare('SELECT * FROM pipeline_schema').all()).toEqual([])
    expect(
      preserved.prepare('SELECT data FROM pipeline_runs WHERE id=?').get('legacy-run')?.data
    ).toBe('{"legacy":true}')
    preserved.exec('DROP TRIGGER refuse_library')
  } finally {
    preserved.close()
  }
  const reopened = new PipelineStore(path)
  try {
    expect(reopened.listV2()).toEqual([])
    expect(reopened.get('legacy-run')).toEqual({ legacy: true })
  } finally {
    reopened.close()
  }
})
it('upgrades the v1 template library without changing its saved drafts', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'orca-v2-library-upgrade-')), 'pipelines.sqlite')
  const initial = new PipelineStore(path)
  initial.close()
  const old = new Database(path)
  old.exec(
    "DROP TABLE pipeline_template_deleted_drafts_v2; UPDATE pipeline_schema SET version=1 WHERE component='pipelines-v2-library'; INSERT INTO pipeline_template_drafts_v2 VALUES ('project-a','draft-a',3,'{\"preserved\":true}','{\"kind\":\"native\"}',42)"
  )
  old.close()
  const upgraded = new PipelineStore(path)
  upgraded.close()
  const verified = new Database(path)
  try {
    expect(
      verified.prepare('SELECT revision,data,updated_at FROM pipeline_template_drafts_v2').all()
    ).toEqual([{ revision: 3, data: '{"preserved":true}', updated_at: 42 }])
    expect(
      verified
        .prepare("SELECT version FROM pipeline_schema WHERE component='pipelines-v2-library'")
        .get()?.version
    ).toBe(2)
    expect(verified.prepare('SELECT * FROM pipeline_template_deleted_drafts_v2').all()).toEqual([])
  } finally {
    verified.close()
  }
})
it('upgrades the pipeline journal while preserving the exact immutable legacy definition and saved run bytes', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'orca-v2-policy-upgrade-')), 'pipelines.sqlite')
  const initial = new PipelineStore(path)
  initial.createV2(pipelineV2AdmissionFixture(pipelineV2ReviewedFixture()))
  initial.close()
  const old = new Database(path)
  old.prepare("UPDATE pipeline_schema SET version=2 WHERE component='pipelines-v2'").run()
  const saved = old.prepare('SELECT data FROM pipeline_runs_v2 WHERE id=?').get('run-1')?.data
  old.close()
  const upgraded = new PipelineStore(path)
  expect(upgraded.getV2('run-1').definition.digest).toBe(
    '0f47d38519ca09025bf0f247610d7aabc22442aaa7d871669d109c3c5088b9c1'
  )
  upgraded.close()
  const verified = new Database(path)
  try {
    expect(
      verified.prepare('SELECT data FROM pipeline_runs_v2 WHERE id=?').get('run-1')?.data
    ).toBe(saved)
    expect(
      verified.prepare("SELECT version FROM pipeline_schema WHERE component='pipelines-v2'").get()
        ?.version
    ).toBe(3)
  } finally {
    verified.close()
  }
})

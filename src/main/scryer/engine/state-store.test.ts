import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { createScryerStateStore, type ScryerStateCommitPlan } from './state-store'
import type { ScryerFlatOperationPolicy } from './types'

async function writeModel(projectPath: string, name: string, model: unknown): Promise<void> {
  await mkdir(join(projectPath, '.scryer'), { recursive: true })
  await writeFile(join(projectPath, '.scryer', name), JSON.stringify(model, null, 2), 'utf8')
}

function model(name: string) {
  return {
    version: '0.3',
    nodes: [{ id: 'api', kind: 'system', name }],
    links: [],
    groups: [],
    sourceMap: { api: [{ pattern: 'src/api.ts' }] },
    boundaries: { api: [{ pattern: 'src/api/**' }] }
  }
}

function policy(reads: ScryerFlatOperationPolicy['reads']): ScryerFlatOperationPolicy {
  return {
    authorization: {
      transports: ['cli'],
      project: { containment: 'workspace_required', allowProjectOverride: true },
      agentRun: { required: false, bindToContext: 'none' }
    },
    lock: 'none',
    lease: 'none',
    reads,
    semanticWrites: [],
    maintenanceWrites: [],
    validation: [],
    sideEffects: []
  }
}

describe('Scryer state store', () => {
  it('falls back to committed for plan reads but strips source routes for plan edits', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-state-fallback-'))
    await writeModel(projectPath, 'model.scry', model('API'))
    const store = createScryerStateStore()

    await expect(store.readPlanned(projectPath)).resolves.toMatchObject({
      sourceMap: { api: [{ pattern: 'src/api.ts' }] }
    })
    await expect(store.readPlannedForEdit(projectPath)).resolves.toMatchObject({
      sourceMap: {},
      boundaries: {}
    })
  })

  it('loads only state declared by policy reads', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-state-declared-'))
    const store = createScryerStateStore()

    await expect(
      store.loadDeclaredState({ projectRoot: projectPath }, policy(['rules']))
    ).resolves.toEqual({})
  })

  it('rolls back primary commit writes after injected ordinary IO failure', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-state-rollback-'))
    await writeModel(projectPath, 'model.scry', model('API'))
    await writeModel(projectPath, 'planned.scry', model('API Draft'))
    const store = createScryerStateStore({ test: { failPrimaryTarget: 'committed' } })
    const plan: ScryerStateCommitPlan = {
      operationId: 'scryer.plan.fold',
      requestId: 'req-state',
      project: { projectRoot: projectPath },
      primary: [
        { target: 'planned', model: model('New Plan') as never },
        { target: 'committed', model: model('New Commit') as never }
      ],
      bestEffort: []
    }

    await expect(store.commit(plan)).rejects.toThrow()
    const planned = JSON.parse(await readFile(join(projectPath, '.scryer', 'planned.scry'), 'utf8'))
    const committed = JSON.parse(await readFile(join(projectPath, '.scryer', 'model.scry'), 'utf8'))
    expect(planned.nodes[0].name).toBe('API Draft')
    expect(committed.nodes[0].name).toBe('API')
  })

  it('keeps successful primary writes when best-effort maintenance fails', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-state-best-effort-'))
    await writeModel(projectPath, 'model.scry', model('API'))
    const store = createScryerStateStore({ test: { failBestEffortTarget: 'baseline' } })
    const plan: ScryerStateCommitPlan = {
      operationId: 'scryer.model.read',
      requestId: 'req-state-best-effort',
      project: { projectRoot: projectPath },
      primary: [{ target: 'committed', model: model('Committed') as never }],
      bestEffort: [{ target: 'baseline', action: 'refresh' }]
    }

    const result = await store.commit(plan)

    expect(result.warnings).toEqual([
      expect.objectContaining({ code: 'maintenance_write_failed', target: 'baseline' })
    ])
    const committed = JSON.parse(await readFile(join(projectPath, '.scryer', 'model.scry'), 'utf8'))
    expect(committed.nodes[0].name).toBe('Committed')
  })
})

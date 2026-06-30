import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { createScryerEngine } from './index'
import type { ScryerOperationContext } from './types'

function testContext(
  projectPath: string,
  overrides: Partial<ScryerOperationContext> = {}
): ScryerOperationContext {
  return {
    requestId: 'req-lease',
    transport: 'cli',
    caller: 'human',
    cwd: projectPath,
    projectRoot: projectPath,
    ...overrides
  }
}

async function writeScryerFile(
  projectPath: string,
  fileName: string,
  value: unknown
): Promise<void> {
  await mkdir(join(projectPath, '.scryer'), { recursive: true })
  await writeFile(join(projectPath, '.scryer', fileName), JSON.stringify(value, null, 2), 'utf8')
}

describe('Scryer engine lease and completion gate', () => {
  it('blocks draft edits while an agent-owned model edit lease is active', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-engine-lease-'))
    await writeScryerFile(projectPath, 'model.scry', {
      version: '0.3',
      nodes: [{ id: 'api', kind: 'system', name: 'API' }],
      links: [],
      groups: [],
      sourceMap: {},
      boundaries: {}
    })
    await writeScryerFile(projectPath, '.model-edit-lease.json', {
      token: 'agent-token',
      owner: 'agent',
      agentRunId: 'run-1'
    })

    const blocked = await createScryerEngine().executeOperation(
      'scryer.node.update',
      { nodes: [{ node_id: 'api', name: 'Blocked API' }] },
      testContext(projectPath)
    )

    expect(blocked).toMatchObject({
      ok: false,
      error: { code: 'lease_required', retryable: true }
    })

    const allowed = await createScryerEngine().executeOperation(
      'scryer.node.update',
      { nodes: [{ node_id: 'api', name: 'Agent API' }] },
      testContext(projectPath, { leaseToken: 'agent-token', caller: 'agent', agentRunId: 'run-1' })
    )

    expect(allowed).toMatchObject({ ok: true })
    const planned = JSON.parse(await readFile(join(projectPath, '.scryer', 'planned.scry'), 'utf8'))
    expect(planned.nodes[0].name).toBe('Agent API')
  })

  it('reports completion gate status after folding planned work', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-engine-completion-'))
    await writeScryerFile(projectPath, 'model.scry', {
      version: '0.3',
      nodes: [{ id: 'api', kind: 'system', name: 'API', responsibilities: [] }],
      links: [],
      groups: [],
      sourceMap: {},
      boundaries: {}
    })
    await writeScryerFile(projectPath, 'planned.scry', {
      version: '0.3',
      nodes: [
        {
          id: 'api',
          kind: 'system',
          name: 'API',
          responsibilities: [{ id: 'resp-1', statement: 'serves public routes' }]
        }
      ],
      links: [],
      groups: [],
      sourceMap: {},
      boundaries: {}
    })

    const result = await createScryerEngine().executeOperation(
      'scryer.plan.fold',
      { node_id: 'api', responsibility_ids: ['resp-1'] },
      testContext(projectPath, { requestId: 'req-completion' })
    )

    expect(result).toMatchObject({
      ok: true,
      meta: {
        completionGate: {
          complete: true,
          pendingCount: 0,
          validationWarningCount: 0
        }
      }
    })
  })
})

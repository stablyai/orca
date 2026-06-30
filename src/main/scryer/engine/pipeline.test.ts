import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { createDefaultScryerOperationCatalog } from './catalog'
import { createScryerEngine } from './index'
import type { ScryerOperationContext } from './types'

function context(projectPath: string, requestId = 'req-pipeline'): ScryerOperationContext {
  return {
    requestId,
    transport: 'cli',
    caller: 'human',
    cwd: projectPath,
    projectRoot: projectPath
  }
}

async function writeModel(projectPath: string): Promise<void> {
  await mkdir(join(projectPath, '.scryer'), { recursive: true })
  await writeFile(
    join(projectPath, '.scryer', 'model.scry'),
    JSON.stringify(
      {
        version: '0.3',
        nodes: [{ id: 'api', kind: 'system', name: 'API' }],
        links: [],
        groups: [],
        sourceMap: {},
        boundaries: {}
      },
      null,
      2
    ),
    'utf8'
  )
}

describe('Scryer operation pipeline', () => {
  it('returns operation_not_found through the shared envelope', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-pipeline-unknown-'))
    const result = await createScryerEngine().executeOperation(
      'scryer.nope',
      {},
      context(projectPath)
    )

    expect(result).toMatchObject({
      ok: false,
      operationId: 'scryer.nope',
      error: { code: 'operation_not_found', details: { operationId: 'scryer.nope' } }
    })
  })

  it('returns invalid_input with structured field errors before loading state', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-pipeline-input-'))
    const result = await createScryerEngine().executeOperation(
      'scryer.node.update',
      { nodes: [] },
      context(projectPath)
    )

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'invalid_input',
        fieldErrors: [expect.objectContaining({ path: 'nodes' })]
      }
    })
  })

  it('maps malformed success payloads to internal_error', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-pipeline-success-'))
    await writeModel(projectPath)
    const catalog = createDefaultScryerOperationCatalog()
    catalog.getOperationContract('scryer.model.validate')!.execute = () => ({
      ok: true,
      outcome: { result: { invalid: true } }
    })

    const result = await createScryerEngine({ catalog }).executeOperation(
      'scryer.model.validate',
      {},
      context(projectPath)
    )

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'internal_error', details: { reason: 'success_schema_failed' } }
    })
  })

  it('maps undeclared operation errors and malformed details to internal_error', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-pipeline-error-'))
    await writeModel(projectPath)
    const catalog = createDefaultScryerOperationCatalog()
    catalog.getOperationContract('scryer.model.validate')!.execute = () => ({
      ok: false,
      failure: { code: 'not_found', message: 'undeclared', details: { entity: 'node', id: 'x' } }
    })

    const undeclared = await createScryerEngine({ catalog }).executeOperation(
      'scryer.model.validate',
      {},
      context(projectPath)
    )
    expect(undeclared).toMatchObject({
      ok: false,
      error: { code: 'internal_error', details: { reason: 'undeclared_error_code' } }
    })

    const malformedCatalog = createDefaultScryerOperationCatalog()
    malformedCatalog.getOperationContract('scryer.link.add')!.execute = () => ({
      ok: false,
      failure: { code: 'illegal_link', message: 'bad details', details: { reason: 'self_link' } }
    })
    const malformed = await createScryerEngine({ catalog: malformedCatalog }).executeOperation(
      'scryer.link.add',
      { links: [{ src: 'api', dst: 'api', label: 'self' }] },
      context(projectPath, 'req-malformed')
    )
    expect(malformed).toMatchObject({
      ok: false,
      error: { code: 'internal_error', details: { reason: 'error_details_schema_failed' } }
    })
  })

  it('resolves branched policy before execution', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-pipeline-branch-'))
    await writeModel(projectPath)
    await writeFile(
      join(projectPath, '.scryer', 'planned.scry'),
      JSON.stringify({
        version: '0.3',
        nodes: [{ id: 'api', kind: 'system', name: 'Public API' }],
        links: [],
        groups: [],
        sourceMap: {},
        boundaries: {}
      }),
      'utf8'
    )

    const result = await createScryerEngine().executeOperation(
      'scryer.plan.fold',
      { mode: 'agent_completion', node_id: 'api' },
      context(projectPath)
    )

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'agent_run_required' }
    })
  })
})

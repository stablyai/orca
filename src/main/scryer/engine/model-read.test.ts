import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { createScryerEngine } from './index'
import type { ScryerOperationContext } from './types'

function testContext(projectPath: string, requestId = 'req-1'): ScryerOperationContext {
  return {
    requestId,
    transport: 'cli',
    caller: 'human',
    cwd: projectPath,
    projectRoot: projectPath
  }
}

describe('scryer.model.read', () => {
  it('reads an existing Scryer 0.3 model on the plan layer', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-engine-read-'))
    await mkdir(join(projectPath, '.scryer'), { recursive: true })
    await writeFile(
      join(projectPath, '.scryer', 'model.scry'),
      JSON.stringify({
        version: '0.3',
        nodes: [],
        links: [],
        groups: [],
        sourceMap: {},
        boundaries: {}
      }),
      'utf8'
    )
    const engine = createScryerEngine()

    const result = await engine.executeOperation('scryer.model.read', {}, testContext(projectPath))

    expect(result).toMatchObject({
      ok: true,
      operationId: 'scryer.model.read',
      requestId: 'req-1',
      result: {
        layer: 'plan',
        model: {
          version: '0.3',
          nodes: [],
          links: [],
          groups: [],
          sourceMap: {},
          boundaries: {}
        }
      }
    })
  })

  it('rejects missing model files as incompatible state', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-engine-missing-'))

    const result = await createScryerEngine().executeOperation(
      'scryer.model.read',
      {},
      testContext(projectPath)
    )

    expect(result).toMatchObject({
      ok: false,
      operationId: 'scryer.model.read',
      requestId: 'req-1',
      error: {
        code: 'incompatible_model',
        retryable: false,
        details: {
          expectedVersion: '0.3'
        }
      }
    })
  })

  it('rejects existing model files without Scryer 0.3 version metadata', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-engine-legacy-'))
    await mkdir(join(projectPath, '.scryer'), { recursive: true })
    await writeFile(
      join(projectPath, '.scryer', 'model.scry'),
      JSON.stringify({ nodes: [], links: [], groups: [] }),
      'utf8'
    )

    const result = await createScryerEngine().executeOperation(
      'scryer.model.read',
      {},
      testContext(projectPath)
    )

    expect(result).toMatchObject({
      ok: false,
      operationId: 'scryer.model.read',
      requestId: 'req-1',
      error: {
        code: 'incompatible_model',
        retryable: false,
        details: {
          actualVersion: undefined,
          expectedVersion: '0.3',
          reason: 'missing_version'
        }
      }
    })
  })
})

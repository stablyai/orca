import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { createScryerEngine } from './index'
import type { ScryerOperationContext } from './types'

function testContext(projectPath: string): ScryerOperationContext {
  return {
    requestId: 'req-validate',
    transport: 'cli',
    caller: 'human',
    cwd: projectPath,
    projectRoot: projectPath
  }
}

describe('scryer.model.validate', () => {
  it('returns structured warnings for validly parsed but structurally suspicious models', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-engine-validate-'))
    await mkdir(join(projectPath, '.scryer'), { recursive: true })
    await writeFile(
      join(projectPath, '.scryer', 'model.scry'),
      JSON.stringify(
        {
          version: '0.3',
          nodes: [{ id: 'component', kind: 'component', name: 'Component without container' }],
          links: [{ id: 'link-1', src: 'component', dst: 'missing', label: 'calls' }],
          groups: [],
          sourceMap: {},
          boundaries: {}
        },
        null,
        2
      ),
      'utf8'
    )

    const result = await createScryerEngine().executeOperation(
      'scryer.model.validate',
      {},
      testContext(projectPath)
    )

    expect(result).toMatchObject({
      ok: true,
      operationId: 'scryer.model.validate',
      requestId: 'req-validate',
      result: {
        findings: expect.arrayContaining([
          expect.objectContaining({ code: 'invalid_hierarchy', path: 'node:component.parentId' }),
          expect.objectContaining({ code: 'missing_reference', path: 'link:link-1.dst' })
        ]),
        validationWarningCount: 2,
        validationErrorCount: 0
      }
    })
  })
})

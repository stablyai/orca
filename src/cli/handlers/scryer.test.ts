import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { Readable } from 'stream'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SCRYER_HANDLERS } from './scryer'
import type { HandlerContext } from '../dispatch'

function ctx(projectPath: string, flags: Map<string, string | boolean>): HandlerContext {
  return {
    flags,
    cwd: projectPath,
    json: true,
    client: {} as HandlerContext['client']
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

describe('orca scryer CLI handlers', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prints model read results as the shared engine envelope', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-cli-read-'))
    await writeModel(projectPath)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await SCRYER_HANDLERS['scryer model read']!(
      ctx(projectPath, new Map([['project', projectPath]]))
    )

    const output = JSON.parse(String(log.mock.calls[0][0]))
    expect(output).toMatchObject({
      ok: true,
      operationId: 'scryer.model.read',
      result: {
        view: 'overview',
        layer: 'plan',
        version: '0.3',
        overview: [expect.objectContaining({ id: 'api' })]
      }
    })
  })

  it('maps stdin JSON into complex write operation input', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-cli-node-update-'))
    await writeModel(projectPath)
    const stdin = Readable.from([
      JSON.stringify({ nodes: [{ node_id: 'api', name: 'Public API' }] })
    ]) as NodeJS.ReadStream & { fd: 0 }
    stdin.fd = 0
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    await SCRYER_HANDLERS['scryer node update']!(
      ctx(
        projectPath,
        new Map([
          ['project', projectPath],
          ['json-input', '-']
        ])
      )
    )

    const output = JSON.parse(String(log.mock.calls[0][0]))
    expect(output).toMatchObject({
      ok: true,
      operationId: 'scryer.node.update',
      result: { updatedCount: 1 }
    })
  })
})

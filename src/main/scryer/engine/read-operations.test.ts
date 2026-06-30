import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { createScryerEngine } from './index'
import type { ScryModel } from './model'
import type { ScryerOperationContext, ScryerOperationId } from './types'

const FINGERPRINT_FILES = [
  'model.scry',
  'planned.scry',
  'history.jsonl',
  '.sync',
  '.anchors.json',
  '.build_edges.json',
  'model.baseline.scry'
]

function context(projectPath: string, requestId: string): ScryerOperationContext {
  return {
    requestId,
    transport: 'cli',
    caller: 'human',
    cwd: projectPath,
    projectRoot: projectPath
  }
}

function testModel(): ScryModel {
  return {
    version: '0.3',
    nodes: [
      { id: 'shop', kind: 'system', name: 'Shop' },
      {
        id: 'api',
        kind: 'container',
        name: 'API',
        parentId: 'shop',
        responsibilities: [{ id: 'resp-api', statement: 'Serves JSON API' }]
      }
    ],
    links: [],
    groups: [],
    sourceMap: {},
    boundaries: {}
  }
}

async function writeProject(model: ScryModel = testModel()) {
  const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-read-ops-'))
  await mkdir(join(projectPath, '.scryer'), { recursive: true })
  await writeFile(
    join(projectPath, '.scryer', 'model.scry'),
    JSON.stringify(model, null, 2),
    'utf8'
  )
  await writeFile(
    join(projectPath, '.scryer', 'planned.scry'),
    JSON.stringify(
      {
        ...model,
        nodes: [...model.nodes, { id: 'web', kind: 'container', name: 'Web', parentId: 'shop' }]
      },
      null,
      2
    ),
    'utf8'
  )
  await writeFile(join(projectPath, '.scryer', 'history.jsonl'), '{"event":"kept"}\n', 'utf8')
  await writeFile(join(projectPath, '.scryer', '.sync'), '{"reconciledAt":"kept"}\n', 'utf8')
  await writeFile(join(projectPath, '.scryer', '.anchors.json'), '{"anchors":"kept"}\n', 'utf8')
  await writeFile(
    join(projectPath, '.scryer', '.build_edges.json'),
    '{"buildEdges":"kept"}\n',
    'utf8'
  )
  await writeFile(
    join(projectPath, '.scryer', 'model.baseline.scry'),
    '{"baseline":"kept"}\n',
    'utf8'
  )
  await writeFile(join(projectPath, 'package.json'), '{"name":"fixture"}\n', 'utf8')
  return projectPath
}

async function fingerprint(projectPath: string) {
  const result: Record<string, string | null> = {}
  for (const file of FINGERPRINT_FILES) {
    const path = join(projectPath, '.scryer', file)
    result[file] = existsSync(path) ? await readFile(path, 'utf8') : null
  }
  return result
}

describe('#31 read operations through catalog pipeline', () => {
  it('returns formal model.read overview, subtree, full, and invalid_input envelopes', async () => {
    const projectPath = await writeProject()
    const engine = createScryerEngine()

    await expect(
      engine.executeOperation('scryer.model.read', {}, context(projectPath, 'read-overview'))
    ).resolves.toMatchObject({
      ok: true,
      result: { view: 'overview', layer: 'plan', overview: expect.any(Array) }
    })
    await expect(
      engine.executeOperation(
        'scryer.model.read',
        { node: 'shop' },
        context(projectPath, 'read-subtree')
      )
    ).resolves.toMatchObject({
      ok: true,
      result: { view: 'subtree', node: expect.objectContaining({ id: 'shop' }) }
    })
    await expect(
      engine.executeOperation(
        'scryer.model.read',
        { view: 'full' },
        context(projectPath, 'read-full')
      )
    ).resolves.toMatchObject({
      ok: true,
      result: {
        view: 'full',
        nodeCount: 3,
        model: { version: '0.3' }
      }
    })
    await expect(
      engine.executeOperation(
        'scryer.model.read',
        { view: 'full', node: 'shop' },
        context(projectPath, 'read-conflict')
      )
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'invalid_input',
        fieldErrors: [expect.objectContaining({ path: 'node' })]
      }
    })
  })

  it('returns typed rules and codebase payloads', async () => {
    const projectPath = await writeProject()
    const engine = createScryerEngine()

    await expect(
      engine.executeOperation('scryer.rules.read', {}, context(projectPath, 'rules-index'))
    ).resolves.toMatchObject({
      ok: true,
      result: {
        mode: 'index',
        rules: expect.arrayContaining([
          expect.objectContaining({
            id: 'rule-1',
            title: expect.any(String),
            tags: expect.any(Array)
          })
        ])
      }
    })
    await expect(
      engine.executeOperation(
        'scryer.rules.read',
        { topic: 'links' },
        context(projectPath, 'rules-topic')
      )
    ).resolves.toMatchObject({
      ok: true,
      result: {
        mode: 'topic',
        rules: expect.arrayContaining([
          expect.objectContaining({ body: expect.stringContaining('edge') })
        ])
      }
    })
    await expect(
      engine.executeOperation(
        'scryer.rules.read',
        { topic: 'definitely-missing-topic' },
        context(projectPath, 'rules-miss')
      )
    ).resolves.toMatchObject({
      ok: true,
      result: { mode: 'miss', guidance: 'choose_topic_from_index', rules: expect.any(Array) }
    })
    await expect(
      engine.executeOperation(
        'scryer.codebase.read',
        { maxDepth: 1 },
        context(projectPath, 'codebase-read')
      )
    ).resolves.toMatchObject({
      ok: true,
      result: {
        root: projectPath,
        entries: [
          expect.objectContaining({
            path: 'package.json',
            markers: ['manifest']
          })
        ],
        summary: expect.objectContaining({ manifestCount: 1 }),
        truncated: expect.any(Boolean)
      }
    })
    await expect(
      engine.executeOperation(
        'scryer.codebase.read',
        { path: '..' },
        context(projectPath, 'codebase-outside-root')
      )
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'invalid_input',
        fieldErrors: [expect.objectContaining({ path: 'path', code: 'outside_project_root' })]
      }
    })
    const outsidePath = await mkdtemp(join(tmpdir(), 'orca-scryer-codebase-outside-'))
    await symlink(outsidePath, join(projectPath, 'outside-link'), 'dir')
    await expect(
      engine.executeOperation(
        'scryer.codebase.read',
        { path: 'outside-link' },
        context(projectPath, 'codebase-symlink-outside-root')
      )
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'invalid_input',
        fieldErrors: [expect.objectContaining({ path: 'path', code: 'outside_project_root' })]
      }
    })
  })

  it('does not mutate Scryer files for plan-layer #31 reads', async () => {
    const projectPath = await writeProject()
    const before = await fingerprint(projectPath)
    const engine = createScryerEngine()
    const calls: Array<[ScryerOperationId, Record<string, unknown>]> = [
      ['scryer.model.read', { view: 'overview', layer: 'plan' }],
      ['scryer.model.search', { query: 'api', layer: 'plan' }],
      [
        'scryer.model.query',
        { where: [{ field: 'kind', op: 'eq', value: 'container' }], layer: 'plan' }
      ],
      ['scryer.rules.read', {}],
      ['scryer.codebase.read', { maxDepth: 1 }]
    ]

    for (const [operationId, input] of calls) {
      const result = await engine.executeOperation(
        operationId,
        input,
        context(projectPath, operationId)
      )
      expect(result).toMatchObject({ ok: true, operationId })
    }

    await expect(fingerprint(projectPath)).resolves.toEqual(before)
  })

  it('allows committed model.read to refresh only model.baseline.scry', async () => {
    const projectPath = await writeProject()
    const before = await fingerprint(projectPath)
    const result = await createScryerEngine().executeOperation(
      'scryer.model.read',
      { view: 'full', layer: 'committed' },
      context(projectPath, 'read-committed')
    )
    const after = await fingerprint(projectPath)

    expect(result).toMatchObject({
      ok: true,
      result: { view: 'full', layer: 'committed', baselineRefreshed: true }
    })
    for (const file of FINGERPRINT_FILES.filter((file) => file !== 'model.baseline.scry')) {
      expect(after[file]).toEqual(before[file])
    }
    expect(after['model.baseline.scry']).not.toEqual(before['model.baseline.scry'])
    expect(after['model.baseline.scry']).toContain('"version": "0.3"')
  })
})

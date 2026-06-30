/* eslint-disable max-lines -- Why: this file exercises the migrated Scryer MCP bridge end-to-end, including task ordering, model mutation, rules, and structure semantics in one fixture-heavy suite. */
import { mkdir, mkdtemp, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'
import { getProjectModelPath, readModel } from './model-store'
import { callScryerTool } from './mcp-tools'

describe('callScryerTool', () => {
  it('sets a model, strips layout-only positions, validates hierarchy, and returns tasks', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-tools-'))
    const result = await callScryerTool(projectPath, {
      toolName: 'set_model',
      arguments: {
        data: JSON.stringify({
          nodes: [
            {
              id: 'system',
              position: { x: 100, y: 100 },
              data: { name: 'Shop', description: 'Commerce system', kind: 'system' }
            },
            {
              id: 'api',
              parentId: 'system',
              position: { x: 120, y: 160 },
              data: {
                name: 'API',
                description: 'HTTP API',
                kind: 'container',
                status: 'proposed',
                contract: { expect: ['Returns JSON'], ask: [], never: [] }
              }
            },
            {
              id: 'users',
              parentId: 'api',
              data: {
                name: 'Users',
                description: 'User workflows',
                kind: 'component',
                status: 'proposed',
                notes: ['Owns signup']
              }
            }
          ],
          edges: [
            { id: 'edge-api-users', source: 'api', target: 'users', data: { label: 'calls' } }
          ]
        })
      }
    })

    expect(result.ok).toBe(true)
    const rawStored = JSON.parse(await readFile(getProjectModelPath(projectPath), 'utf8'))
    expect(
      rawStored.nodes.find((node: { id: string }) => node.id === 'api')?.position
    ).toBeUndefined()

    const task = await callScryerTool(projectPath, {
      toolName: 'get_task',
      arguments: {}
    })
    expect(task.ok).toBe(true)
    expect(task.content).toContain('Users')
    expect(task.content).toContain('Returns JSON')
    expect(task.content).toContain('Owns signup')

    const update = await callScryerTool(projectPath, {
      toolName: 'update_nodes',
      arguments: {
        nodes: [
          {
            node_id: 'users',
            status: 'implemented',
            reason: 'Added signup service',
            source: [{ pattern: 'src/users/**/*.ts' }]
          }
        ]
      }
    })

    expect(update.ok, JSON.stringify(update)).toBe(true)
    const updated = await readModel(projectPath)
    expect(updated.nodes.find((node) => node.id === 'users')?.data.status).toBe('implemented')
    expect(updated.sourceMap?.users).toEqual([{ pattern: 'src/users/**/*.ts' }])
  })

  it('updates strict Scryer nodes through catalog operations without rewriting model.scry as legacy C4', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-tools-strict-update-'))
    await mkdir(join(projectPath, '.scryer'), { recursive: true })
    await writeFile(
      getProjectModelPath(projectPath),
      JSON.stringify(
        {
          version: '0.3',
          nodes: [
            { id: 'shop', kind: 'system', name: 'Shop' },
            { id: 'api', kind: 'container', name: 'API', parentId: 'shop' }
          ],
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

    const update = await callScryerTool(projectPath, {
      toolName: 'update_nodes',
      arguments: {
        nodes: [
          {
            node_id: 'api',
            description: 'Updated through MCP bridge'
          }
        ]
      }
    })

    expect(update.ok, JSON.stringify(update)).toBe(true)
    const committed = JSON.parse(await readFile(getProjectModelPath(projectPath), 'utf8'))
    const planned = JSON.parse(await readFile(join(projectPath, '.scryer', 'planned.scry'), 'utf8'))
    expect(committed.version).toBe('0.3')
    expect(committed.nodes.find((node: { id: string }) => node.id === 'api')?.data).toBeUndefined()
    expect(planned.version).toBe('0.3')
    expect(planned.nodes.find((node: { id: string }) => node.id === 'api')?.description).toBe(
      'Updated through MCP bridge'
    )
  })

  it('deletes strict Scryer nodes through catalog operations into planned state', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-tools-strict-delete-'))
    await mkdir(join(projectPath, '.scryer'), { recursive: true })
    await writeFile(
      getProjectModelPath(projectPath),
      JSON.stringify(
        {
          version: '0.3',
          nodes: [
            { id: 'shop', kind: 'system', name: 'Shop' },
            { id: 'api', kind: 'container', name: 'API', parentId: 'shop' },
            { id: 'handler', kind: 'component', name: 'Handler', parentId: 'api' }
          ],
          links: [{ id: 'link-handler-api', src: 'handler', dst: 'api', label: 'serves' }],
          groups: [{ id: 'api-group', name: 'API Group', memberIds: ['api', 'handler'] }],
          sourceMap: { handler: [{ pattern: 'src/api/handler.ts' }] },
          boundaries: { api: [{ pattern: 'src/api/**/*.ts' }] }
        },
        null,
        2
      ),
      'utf8'
    )

    const deleted = await callScryerTool(projectPath, {
      toolName: 'delete_nodes',
      arguments: { node_ids: ['api'] }
    })

    expect(deleted.ok, JSON.stringify(deleted)).toBe(true)
    const committed = JSON.parse(await readFile(getProjectModelPath(projectPath), 'utf8'))
    const planned = JSON.parse(await readFile(join(projectPath, '.scryer', 'planned.scry'), 'utf8'))
    expect(committed.nodes.map((node: { id: string }) => node.id)).toEqual([
      'shop',
      'api',
      'handler'
    ])
    expect(planned.nodes.map((node: { id: string }) => node.id)).toEqual(['shop'])
    expect(planned.links).toEqual([])
    expect(planned.sourceMap.handler).toBeUndefined()
    expect(planned.boundaries.api).toBeUndefined()
  })

  it('updates strict Scryer task fields through catalog operations into planned state', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-tools-strict-update-'))
    await mkdir(join(projectPath, '.scryer'), { recursive: true })
    await writeFile(
      getProjectModelPath(projectPath),
      JSON.stringify(
        {
          version: '0.3',
          nodes: [
            { id: 'shop', kind: 'system', name: 'Shop' },
            { id: 'api', kind: 'container', name: 'API', parentId: 'shop' },
            { id: 'handler', kind: 'component', name: 'Handler', parentId: 'api' }
          ],
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

    const updated = await callScryerTool(projectPath, {
      toolName: 'update_nodes',
      arguments: {
        nodes: [
          {
            node_id: 'handler',
            status: 'implemented',
            reason: 'Implemented handler',
            contract: { expect: [{ text: 'Has test', passed: true }], ask: [], never: [] },
            notes: ['Keep route logic thin'],
            shape: 'hexagon',
            source: [{ pattern: 'src/api/handler.ts', line: 1 }],
            sources: [{ pattern: 'src/api/**/*.ts', comment: 'route handlers' }]
          }
        ]
      }
    })

    expect(updated.ok, JSON.stringify(updated)).toBe(true)
    const planned = JSON.parse(await readFile(join(projectPath, '.scryer', 'planned.scry'), 'utf8'))
    expect(planned.nodes.find((node: { id: string }) => node.id === 'handler')).toMatchObject({
      notes: 'Keep route logic thin',
      appearance: {
        status: 'implemented',
        statusReason: 'Implemented handler',
        shape: 'hexagon',
        contract: { expect: [{ text: 'Has test', passed: true }], ask: [], never: [] }
      }
    })
    expect(planned.sourceMap.handler).toEqual([{ pattern: 'src/api/handler.ts', line: 1 }])
    expect(planned.boundaries.handler).toEqual([
      { pattern: 'src/api/**/*.ts', comment: 'route handlers' }
    ])
  })

  it('advances MCP get_task from strict planned state after update_nodes', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-tools-strict-task-'))
    await mkdir(join(projectPath, '.scryer'), { recursive: true })
    await writeFile(
      getProjectModelPath(projectPath),
      JSON.stringify(
        {
          version: '0.3',
          nodes: [
            { id: 'system', kind: 'system', name: 'Issue Tracker' },
            { id: 'api', kind: 'container', name: 'API', parentId: 'system' },
            {
              id: 'service',
              kind: 'component',
              name: 'Issue Service',
              parentId: 'api',
              appearance: { status: 'proposed' }
            },
            {
              id: 'controller',
              kind: 'component',
              name: 'Issue Controller',
              parentId: 'api',
              appearance: { status: 'proposed' }
            }
          ],
          links: [
            { id: 'edge-controller-service', src: 'controller', dst: 'service', label: 'uses' }
          ],
          groups: [],
          sourceMap: {},
          boundaries: {}
        },
        null,
        2
      ),
      'utf8'
    )

    const firstTask = await callScryerTool(projectPath, {
      toolName: 'get_task',
      arguments: { node_id: 'api' }
    })
    expect(firstTask.ok).toBe(true)
    expect(firstTask.content).toContain('Build: Issue Service')
    expect(firstTask.content).not.toContain('Build: Issue Controller')

    const update = await callScryerTool(projectPath, {
      toolName: 'update_nodes',
      arguments: {
        nodes: [
          {
            node_id: 'service',
            status: 'implemented',
            reason: 'Implemented service first',
            source: [{ pattern: 'src/services/issues.ts' }]
          }
        ]
      }
    })
    expect(update.ok, JSON.stringify(update)).toBe(true)

    const secondTask = await callScryerTool(projectPath, {
      toolName: 'get_task',
      arguments: { node_id: 'api' }
    })
    expect(secondTask.ok).toBe(true)
    expect(secondTask.content).toContain('Build: Issue Controller')
    expect(secondTask.content).not.toContain('Build: Issue Service')
  })

  it('covers the strict MCP compatibility alias matrix', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-tools-strict-matrix-'))
    await mkdir(join(projectPath, '.scryer'), { recursive: true })
    await writeFile(
      getProjectModelPath(projectPath),
      JSON.stringify(
        {
          version: '0.3',
          nodes: [
            { id: 'system', kind: 'system', name: 'Shop' },
            { id: 'api', kind: 'container', name: 'API', parentId: 'system' },
            { id: 'worker', kind: 'container', name: 'Worker', parentId: 'system' }
          ],
          links: [{ id: 'edge-api-worker', src: 'api', dst: 'worker', label: 'calls' }],
          groups: [],
          sourceMap: {},
          boundaries: {}
        },
        null,
        2
      ),
      'utf8'
    )

    const deleteEdges = await callScryerTool(projectPath, {
      toolName: 'delete_edges',
      arguments: { edge_ids: ['edge-api-worker'] }
    })
    expect(deleteEdges.ok, JSON.stringify(deleteEdges)).toBe(true)
    let planned = JSON.parse(await readFile(join(projectPath, '.scryer', 'planned.scry'), 'utf8'))
    expect(planned.links).toEqual([])

    const setGroups = await callScryerTool(projectPath, {
      toolName: 'set_groups',
      arguments: {
        data: JSON.stringify([
          {
            id: 'group-runtime',
            name: 'Runtime',
            memberIds: ['api', 'worker'],
            parentNodeId: 'system'
          }
        ])
      }
    })
    expect(setGroups.ok, JSON.stringify(setGroups)).toBe(true)
    planned = JSON.parse(await readFile(join(projectPath, '.scryer', 'planned.scry'), 'utf8'))
    expect(planned.groups).toContainEqual(
      expect.objectContaining({ id: 'group-runtime', name: 'Runtime' })
    )

    const deleteGroup = await callScryerTool(projectPath, {
      toolName: 'delete_group',
      arguments: { group_id: 'group-runtime' }
    })
    expect(deleteGroup.ok, JSON.stringify(deleteGroup)).toBe(true)
    planned = JSON.parse(await readFile(join(projectPath, '.scryer', 'planned.scry'), 'utf8'))
    expect(planned.groups.some((group: { id?: string }) => group.id === 'group-runtime')).toBe(
      false
    )

    const rejectedTools = [
      {
        toolName: 'add_nodes',
        arguments: { nodes: [{ name: 'Legacy', kind: 'system' }] },
        message: 'add_nodes is not supported'
      },
      {
        toolName: 'set_node',
        arguments: { node_id: 'system', data: JSON.stringify({ nodes: [], edges: [] }) },
        message: 'set_node is not supported'
      },
      {
        toolName: 'set_flows',
        arguments: { data: JSON.stringify([]) },
        message: 'set_flows is not supported'
      },
      {
        toolName: 'delete_flow',
        arguments: { flow_id: 'flow-1' },
        message: 'delete_flow is not supported'
      }
    ] as const

    for (const rejected of rejectedTools) {
      const result = await callScryerTool(projectPath, {
        toolName: rejected.toolName,
        arguments: rejected.arguments
      })
      expect(result.ok).toBe(false)
      expect(result.content).toContain(rejected.message)
    }
  })

  it('mirrors Scryer MCP node, edge, source-map, structure, and change semantics', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-tools-live-'))
    await mkdir(join(projectPath, 'src', 'api'), { recursive: true })
    await writeFile(join(projectPath, 'package.json'), '{"name":"sample"}\n')
    await writeFile(join(projectPath, 'src', 'api', 'index.ts'), 'export const api = true\n')

    const listModels = await callScryerTool(projectPath, {
      toolName: 'list_models',
      arguments: {}
    })
    expect(listModels.ok).toBe(true)
    expect(listModels.content).toContain('.scryer/model.scry')

    await callScryerTool(projectPath, {
      toolName: 'set_model',
      arguments: {
        data: JSON.stringify({
          nodes: [
            {
              id: 'system',
              data: { name: 'Shop', description: 'Commerce system', kind: 'system' }
            },
            {
              id: 'web',
              parentId: 'system',
              data: {
                name: 'Web',
                description: 'Web container',
                kind: 'container',
                status: 'proposed'
              }
            },
            {
              id: 'api',
              parentId: 'system',
              data: {
                name: 'API',
                description: 'API container',
                kind: 'container',
                status: 'proposed'
              }
            },
            {
              id: 'handler',
              parentId: 'api',
              data: {
                name: 'Handler',
                description: 'HTTP handler',
                kind: 'component',
                status: 'proposed'
              }
            },
            {
              id: 'operation',
              parentId: 'handler',
              data: {
                name: 'listUsers',
                description: 'List users',
                kind: 'operation',
                status: 'proposed'
              }
            }
          ],
          edges: []
        })
      }
    })

    const addEdge = await callScryerTool(projectPath, {
      toolName: 'add_edges',
      arguments: { edges: [{ source: 'web', target: 'api', label: 'calls', method: 'HTTP' }] }
    })
    expect(addEdge.ok).toBe(true)

    const updateEdge = await callScryerTool(projectPath, {
      toolName: 'update_edges',
      arguments: { edges: [{ edge_id: 'edge-web-api', label: 'requests', method: 'REST' }] }
    })
    expect(updateEdge.ok).toBe(true)

    const updateNode = await callScryerTool(projectPath, {
      toolName: 'update_nodes',
      arguments: {
        nodes: [
          {
            node_id: 'handler',
            name: 'User Handler',
            description: 'Owns user HTTP routes',
            technology: 'TypeScript',
            sources: [{ pattern: 'src/api/**/*.ts', comment: 'route handlers' }],
            contract: { expect: [{ text: 'Has live test', passed: true }], ask: [], never: [] },
            notes: ['Keep route logic thin'],
            status: 'implemented',
            reason: 'Implemented handler and tests',
            source: [{ pattern: 'src/api/**/*.ts', line: 1 }]
          }
        ]
      }
    })
    expect(updateNode.ok).toBe(true)

    const sourceMap = await callScryerTool(projectPath, {
      toolName: 'update_source_map',
      arguments: {
        entries: [
          { node_id: 'operation', locations: [{ pattern: 'src/api/index.ts', line: 1 }] },
          { node_id: 'operation', locations: [] }
        ]
      }
    })
    expect(sourceMap.ok).toBe(true)

    const subtree = await callScryerTool(projectPath, {
      toolName: 'get_node',
      arguments: { node_id: 'api' }
    })
    expect(subtree.ok).toBe(true)
    expect(subtree.content).toContain('"descendants"')
    expect(subtree.content).toContain('User Handler')
    expect(subtree.content).toContain('"external_node_name": "Web"')

    const structure = await callScryerTool(projectPath, {
      toolName: 'get_structure',
      arguments: { path: projectPath }
    })
    expect(structure.ok).toBe(true)
    expect(structure.content).toContain('package.json')
    expect(structure.content).toContain('[manifest]')

    const modelAfterUserEdit = await readModel(projectPath)
    modelAfterUserEdit.nodes.push({
      id: 'manual',
      type: 'c4',
      data: { name: 'Manual Node', description: 'User-added diagram node', kind: 'system' }
    })
    await import('./model-store').then(({ writeModel }) =>
      writeModel(projectPath, modelAfterUserEdit)
    )

    const changes = await callScryerTool(projectPath, {
      toolName: 'get_changes',
      arguments: {}
    })
    expect(changes.ok).toBe(true)
    expect(changes.content).toContain('Nodes added')
    expect(changes.content).toContain('Manual Node')

    const deleteNodes = await callScryerTool(projectPath, {
      toolName: 'delete_nodes',
      arguments: { node_ids: ['api'] }
    })
    expect(deleteNodes.ok).toBe(true)
    const deleted = await readModel(projectPath)
    expect(deleted.nodes.map((node) => node.id)).not.toContain('operation')
    expect(deleted.edges).toEqual([])
    expect(deleted.sourceMap?.handler).toBeUndefined()
  })

  it('rejects components that are not nested under containers', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-tools-invalid-'))
    const result = await callScryerTool(projectPath, {
      toolName: 'set_model',
      arguments: {
        data: JSON.stringify({
          nodes: [
            {
              id: 'bad-component',
              data: { name: 'Loose Component', description: 'Invalid', kind: 'component' }
            }
          ],
          edges: []
        })
      }
    })

    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/Component .* must have a container parent/)
  })

  it('prioritizes deployment group scaffolds before individual container work', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-tools-group-task-'))
    await callScryerTool(projectPath, {
      toolName: 'set_model',
      arguments: {
        data: JSON.stringify({
          nodes: [
            { id: 'system', data: { name: 'Shop', description: 'Commerce', kind: 'system' } },
            {
              id: 'web',
              parentId: 'system',
              data: {
                name: 'Website',
                description: 'Customer storefront',
                kind: 'container',
                technology: 'Next.js',
                status: 'proposed',
                contract: { expect: ['Serves product pages'], ask: [], never: [] }
              }
            },
            {
              id: 'cms',
              parentId: 'system',
              data: {
                name: 'CMS Admin',
                description: 'Editorial admin surface',
                kind: 'container',
                technology: 'Payload',
                status: 'proposed'
              }
            }
          ],
          edges: [],
          groups: [
            {
              id: 'next-app',
              name: 'Next App',
              description: 'Containers deployed in the same runtime',
              memberIds: ['web', 'cms'],
              contract: { expect: ['Share one deployment'], ask: [], never: ['Create two repos'] }
            }
          ]
        })
      }
    })

    const task = await callScryerTool(projectPath, {
      toolName: 'get_task',
      arguments: {}
    })

    expect(task.ok).toBe(true)
    expect(task.content).toContain('## Scaffold: Next App')
    expect(task.content).toContain('Website')
    expect(task.content).toContain('CMS Admin')
    expect(task.content).toContain('Share one deployment')
    expect(task.content).toContain('Create two repos')
    expect(task.content).toContain('update_nodes')
  })

  it('orders sibling component tasks by dependency edges and reports cycles', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-tools-component-task-'))
    await callScryerTool(projectPath, {
      toolName: 'set_model',
      arguments: {
        data: JSON.stringify({
          nodes: [
            { id: 'system', data: { name: 'Shop', description: 'Commerce', kind: 'system' } },
            {
              id: 'api',
              parentId: 'system',
              data: { name: 'API', description: 'HTTP API', kind: 'container', status: 'proposed' }
            },
            {
              id: 'controller',
              parentId: 'api',
              data: {
                name: 'Controller',
                description: 'HTTP entrypoint',
                kind: 'component',
                status: 'proposed'
              }
            },
            {
              id: 'service',
              parentId: 'api',
              data: {
                name: 'Service',
                description: 'Business rules',
                kind: 'component',
                status: 'proposed'
              }
            }
          ],
          edges: [
            {
              id: 'edge-controller-service',
              source: 'controller',
              target: 'service',
              data: { label: 'uses' }
            }
          ]
        })
      }
    })

    const firstTask = await callScryerTool(projectPath, {
      toolName: 'get_task',
      arguments: { node_id: 'api' }
    })
    expect(firstTask.ok).toBe(true)
    expect(firstTask.content).toContain('Build: Service')
    expect(firstTask.content).not.toContain('Build: Controller')

    const reverseEdge = await callScryerTool(projectPath, {
      toolName: 'add_edges',
      arguments: { edges: [{ source: 'service', target: 'controller', label: 'calls' }] }
    })
    expect(reverseEdge.ok).toBe(true)

    const cycle = await callScryerTool(projectPath, {
      toolName: 'get_task',
      arguments: { node_id: 'api' }
    })
    expect(cycle.ok).toBe(true)
    expect(cycle.content).toContain('Dependency cycle detected')
    expect(cycle.content).toContain('Controller')
    expect(cycle.content).toContain('Service')
  })

  it('prompts parent status propagation and proposed member implementation after components finish', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-tools-parent-task-'))
    await callScryerTool(projectPath, {
      toolName: 'set_model',
      arguments: {
        data: JSON.stringify({
          nodes: [
            {
              id: 'system',
              data: { name: 'Shop', description: 'Commerce', kind: 'system', status: 'proposed' }
            },
            {
              id: 'api',
              parentId: 'system',
              data: { name: 'API', description: 'HTTP API', kind: 'container', status: 'proposed' }
            },
            {
              id: 'users',
              parentId: 'api',
              data: {
                name: 'Users',
                description: 'User workflows',
                kind: 'component',
                status: 'implemented',
                statusReason: 'Implemented user workflows'
              }
            },
            {
              id: 'listUsers',
              parentId: 'users',
              data: {
                name: 'listUsers',
                description: 'Lists users',
                kind: 'operation',
                status: 'proposed'
              }
            },
            {
              id: 'User',
              parentId: 'users',
              data: {
                name: 'User',
                description: 'User data',
                kind: 'model',
                status: 'proposed',
                properties: [{ label: 'id', description: 'Unique id' }]
              }
            }
          ],
          edges: []
        })
      }
    })

    const task = await callScryerTool(projectPath, {
      toolName: 'get_task',
      arguments: {}
    })

    expect(task.ok).toBe(true)
    expect(task.content).toContain('All 1 tasks complete')
    expect(task.content).toContain('Mark these parent nodes as implemented')
    expect(task.content).toContain('API')
    expect(task.content).toContain('These member nodes are still proposed')
    expect(task.content).toContain('listUsers')
    expect(task.content).toContain('User')
  })

  it('returns the migrated Scryer modeling rules as the MCP rules source', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-tools-rules-'))
    const rules = await callScryerTool(projectPath, {
      toolName: 'get_rules',
      arguments: {}
    })

    expect(rules.ok).toBe(true)
    expect(rules.content).toContain('One edge per relationship')
    expect(rules.content).toContain('No cross-container component edges')
    expect(rules.content).toContain('Implementation loop')
  })

  it('warns when a node description mentions a sibling without a relationship edge', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-mention-edge-'))
    await callScryerTool(projectPath, {
      toolName: 'set_model',
      arguments: {
        data: JSON.stringify({
          nodes: [
            {
              id: 'system',
              data: { name: 'Shop', description: 'Commerce system', kind: 'system' }
            },
            {
              id: 'api',
              parentId: 'system',
              data: {
                name: 'API',
                description: 'Calls @[Worker]',
                kind: 'container'
              }
            },
            {
              id: 'worker',
              parentId: 'system',
              data: { name: 'Worker', description: 'Background jobs', kind: 'container' }
            }
          ],
          edges: []
        })
      }
    })

    const invalid = await callScryerTool(projectPath, {
      toolName: 'validate_model',
      arguments: {}
    })
    expect(invalid.ok).toBe(false)
    expect(invalid.content).toContain('API mentions Worker')

    const fixed = await callScryerTool(projectPath, {
      toolName: 'add_edges',
      arguments: {
        edges: [{ source: 'api', target: 'worker', label: 'calls' }]
      }
    })
    expect(fixed.ok).toBe(true)

    const valid = await callScryerTool(projectPath, {
      toolName: 'validate_model',
      arguments: {}
    })
    expect(valid.ok).toBe(true)
  })

  it('warns when a node description mentions a missing sibling', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'orca-scryer-mention-missing-'))
    await callScryerTool(projectPath, {
      toolName: 'set_model',
      arguments: {
        data: JSON.stringify({
          nodes: [
            {
              id: 'system',
              data: { name: 'Shop', description: 'Commerce system', kind: 'system' }
            },
            {
              id: 'api',
              parentId: 'system',
              data: {
                name: 'API',
                description: 'Calls @[MissingWorker]',
                kind: 'container'
              }
            }
          ],
          edges: []
        })
      }
    })

    const invalid = await callScryerTool(projectPath, {
      toolName: 'validate_model',
      arguments: {}
    })
    expect(invalid.ok).toBe(false)
    expect(invalid.content).toContain('API mentions MissingWorker but no sibling node matches it')
  })
})

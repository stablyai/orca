import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readOmpMcpServers } from './omp-mcp-servers'

describe('readOmpMcpServers', () => {
  let root: string
  let cwd: string
  let agentDir: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'omp-mcp-'))
    cwd = join(root, 'project')
    agentDir = join(root, 'agent')
    await mkdir(join(cwd, '.omp'), { recursive: true })
    await mkdir(agentDir, { recursive: true })
    await writeFile(
      join(cwd, '.omp', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          memory: { command: 'project-memory', args: ['--port', '1'] },
          paused: { command: 'paused', enabled: 'false' }
        }
      })
    )
    await writeFile(join(cwd, '.omp', '.mcp.json'), '{ not json')
    await writeFile(
      join(agentDir, 'mcp.json'),
      JSON.stringify({
        disabledServers: ['muted'],
        mcpServers: {
          memory: { command: 'user-memory' },
          docs: {
            type: 'sse',
            url: 'https://docs.example/sse',
            headers: { Authorization: 'Bearer ${DOCS_TOKEN}', Team: '${TEAM:-core}' }
          },
          muted: { url: 'https://muted.example/mcp' },
          pinned: { command: 'node', args: ['server.js'], cwd: '/tools' }
        }
      })
    )
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('sends the servers OMP itself would connect, project entries first', async () => {
    const env = { PI_CODING_AGENT_DIR: agentDir, DOCS_TOKEN: 'secret' }

    await expect(readOmpMcpServers({ cwd, env, version: '19.0.1' })).resolves.toEqual([
      { name: 'memory', command: 'project-memory', args: ['--port', '1'], env: [] },
      {
        type: 'sse',
        name: 'docs',
        url: 'https://docs.example/sse',
        headers: [
          { name: 'Authorization', value: 'Bearer secret' },
          { name: 'Team', value: 'core' }
        ]
      }
    ])
  })

  it('leaves out what the user turned off in OMP settings', async () => {
    await writeFile(
      join(agentDir, 'config.yml'),
      'mcp:\n  enableProjectConfig: false\ndisabledExtensions:\n  - mcp:docs\n'
    )
    const env = { PI_CODING_AGENT_DIR: agentDir, DOCS_TOKEN: 'secret' }

    const servers = await readOmpMcpServers({ cwd, env, version: '19.0.1' })

    expect(servers).toEqual([{ name: 'memory', command: 'user-memory', args: [], env: [] }])
  })

  it('sends none to releases where a failing server stops the chat opening', async () => {
    const env = { PI_CODING_AGENT_DIR: agentDir }

    await expect(readOmpMcpServers({ cwd, env, version: '18.12.5' })).resolves.toEqual([])
    await expect(readOmpMcpServers({ cwd, env, version: null })).resolves.toEqual([])
  })
})

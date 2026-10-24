import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  expandEnv,
  ompMcpServerFiles,
  parseAcpMcpServers,
  readAcpMcpServers
} from './acp-mcp-servers'

/** Writes one MCP document, creating the folders its path needs. */
async function writeDocument(path: string, document: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify(document), 'utf8')
}

describe('reading an agent own MCP document as ACP servers', () => {
  it('maps a stdio server, expanding the environment in args and env values', () => {
    const read = parseAcpMcpServers(
      JSON.stringify({
        mcpServers: {
          hub: {
            command: 'uv',
            args: ['run', '--directory', '${HUB_DIR}'],
            env: { MCP_HUB_CONFIG: '${HUB_DIR}/servers.yaml', EMPTY: '${MISSING:-fallback}' }
          }
        }
      }),
      { HUB_DIR: '/srv/hub' }
    )
    expect(read).toEqual({
      servers: [
        {
          name: 'hub',
          command: 'uv',
          args: ['run', '--directory', '/srv/hub'],
          env: [
            { name: 'MCP_HUB_CONFIG', value: '/srv/hub/servers.yaml' },
            { name: 'EMPTY', value: 'fallback' }
          ]
        }
      ],
      skipped: []
    })
  })

  it('maps http and sse servers, and reports entries the protocol cannot carry', () => {
    const read = parseAcpMcpServers(
      JSON.stringify({
        mcpServers: {
          remote: {
            type: 'http',
            url: 'https://example.test/mcp',
            headers: { Authorization: 'Bearer ${TOKEN}' }
          },
          legacy: { type: 'sse', url: 'https://example.test/sse' },
          disabled: { command: 'nope', enabled: false },
          missingCommand: { args: ['x'] },
          missingUrl: { type: 'http' },
          otherTransport: { type: 'websocket', command: 'x' },
          needsDirectory: { command: 'node', cwd: '/srv/server' },
          remoteWithDirectory: { type: 'http', url: 'https://example.test/other', cwd: '/ignored' }
        }
      }),
      { TOKEN: 'secret' }
    )
    expect(read.servers).toEqual([
      {
        type: 'http',
        name: 'remote',
        url: 'https://example.test/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer secret' }]
      },
      { type: 'sse', name: 'legacy', url: 'https://example.test/sse', headers: [] },
      {
        type: 'http',
        name: 'remoteWithDirectory',
        url: 'https://example.test/other',
        headers: []
      }
    ])
    expect(read.skipped).toEqual([
      { name: 'disabled', reason: 'disabled' },
      { name: 'missingCommand', reason: 'unsupported' },
      { name: 'missingUrl', reason: 'unsupported' },
      { name: 'otherTransport', reason: 'unsupported' },
      { name: 'needsDirectory', reason: 'cwd' }
    ])
  })

  it('honours the document denylist above every definition', () => {
    const read = parseAcpMcpServers(
      JSON.stringify({
        mcpServers: { allowed: { command: 'a' }, denied: { command: 'b' } },
        disabledServers: ['denied']
      })
    )
    expect(read.servers.map((server) => server.name)).toEqual(['allowed'])
    expect(read.skipped).toEqual([{ name: 'denied', reason: 'disabled' }])
  })

  it('treats a document it cannot parse as no servers rather than throwing', () => {
    for (const content of ['{ not json', '{"servers": {}}', '{"mcpServers": []}']) {
      expect(parseAcpMcpServers(content)).toEqual({ servers: [], skipped: [] })
    }
  })

  it('leaves an unknown placeholder empty instead of the literal text', () => {
    expect(expandEnv('${MISSING}', {})).toBe('')
    expect(expandEnv('${A}-${B:-b}', { A: 'a' })).toBe('a-b')
  })
})

describe('which files a chat reads, and in what order', () => {
  it('reads OMP project, its profile, then the portable files its terminal lane shares', () => {
    expect(
      ompMcpServerFiles({ cwd: '/work/project', env: { PI_CODING_AGENT_DIR: '/work/profile' } })
    ).toEqual([
      { path: join('/work/project', '.omp', 'mcp.json') },
      { path: join('/work/profile', 'mcp.json') },
      { path: join('/work/project', 'mcp.json') },
      { path: join('/work/project', '.mcp.json') }
    ])
    expect(ompMcpServerFiles({ cwd: '/work/project', env: {} })).toEqual([
      { path: join('/work/project', '.omp', 'mcp.json') },
      { path: join('/work/project', 'mcp.json') },
      { path: join('/work/project', '.mcp.json') }
    ])
  })

  it('keeps the first definition of a name and skips files that are missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acp-mcp-servers-'))
    const project = join(root, 'project')
    const profile = join(root, 'profile')
    await writeDocument(join(project, '.omp', 'mcp.json'), {
      mcpServers: {
        shared: { command: 'project-copy' },
        projectOnly: { command: 'project-server' }
      }
    })
    await writeDocument(join(profile, 'mcp.json'), {
      mcpServers: {
        shared: { command: 'profile-copy' },
        profileOnly: { command: 'profile-server' }
      }
    })

    const read = await readAcpMcpServers(
      ompMcpServerFiles({ cwd: project, env: { PI_CODING_AGENT_DIR: profile } })
    )

    expect(
      read.servers.map((server) => [server.name, 'command' in server && server.command])
    ).toEqual([
      ['shared', 'project-copy'],
      ['projectOnly', 'project-server'],
      ['profileOnly', 'profile-server']
    ])
  })

  it('lets a higher-priority file disable a name a lower-priority file defines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acp-mcp-servers-'))
    const project = join(root, 'project')
    const profile = join(root, 'profile')
    await writeDocument(join(project, '.omp', 'mcp.json'), {
      mcpServers: { hub: { command: 'project-hub', enabled: false } }
    })
    await writeDocument(join(profile, 'mcp.json'), {
      mcpServers: { hub: { command: 'profile-hub' } }
    })

    const read = await readAcpMcpServers(
      ompMcpServerFiles({ cwd: project, env: { PI_CODING_AGENT_DIR: profile } })
    )

    expect(read.servers).toEqual([])
    expect(read.skipped).toEqual([{ name: 'hub', reason: 'disabled' }])
  })

  it('applies a denylist from any selected file to every definition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acp-mcp-servers-'))
    const project = join(root, 'project')
    const profile = join(root, 'profile')
    await writeDocument(join(project, '.omp', 'mcp.json'), {
      mcpServers: { shared: { command: 'project-copy' } }
    })
    await writeDocument(join(profile, 'mcp.json'), {
      mcpServers: {},
      disabledServers: ['shared']
    })

    const read = await readAcpMcpServers(
      ompMcpServerFiles({ cwd: project, env: { PI_CODING_AGENT_DIR: profile } })
    )

    expect(read.servers).toEqual([])
    expect(read.skipped).toEqual([{ name: 'shared', reason: 'disabled' }])
  })

  it('returns nothing when no file exists, and never fails a start over a bad file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acp-mcp-servers-'))
    const files = ompMcpServerFiles({ cwd: root, env: {} })
    expect(await readAcpMcpServers(files)).toEqual({ servers: [], skipped: [] })

    await mkdir(join(root, '.omp'), { recursive: true })
    await writeFile(join(root, '.omp', 'mcp.json'), 'not json', 'utf8')
    expect(await readAcpMcpServers(files)).toEqual({ servers: [], skipped: [] })
  })
})

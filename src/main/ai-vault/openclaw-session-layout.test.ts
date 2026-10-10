import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { discoverRemoteSourceCandidates } from './remote-session-scanner-discovery'
import { remoteSessionSources } from './remote-session-scanner-sources'
import type { RemoteScannerContext } from './remote-session-scanner-types'
import { AI_VAULT_AGENT_SOURCES } from './session-scanner-agent-sources'
import { walkSessionFiles } from './session-scanner-discovery'

// The layout reported in #11394: canonical sessions beside an embedded Codex home.
const CANONICAL = ['main', 'sessions', 'canonical.jsonl']
const NESTED_CANONICAL = ['main', 'sessions', 'archive', 'older.jsonl']
const EMBEDDED_CODEX = ['main', 'agent', 'codex-home', 'sessions', '2026', 'rollout-x.jsonl']

let home: string
let agentsDir: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'openclaw-layout-'))
  agentsDir = join(home, '.openclaw', 'agents')
  for (const segments of [CANONICAL, NESTED_CANONICAL, EMBEDDED_CODEX]) {
    const path = join(agentsDir, ...segments)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, '{}\n')
  }
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function relativeToAgents(paths: readonly string[]): string[] {
  return paths.map((path) => relative(agentsDir, path).split(/[\\/]/).join('/')).sort()
}

const EXPECTED = [CANONICAL.join('/'), NESTED_CANONICAL.join('/')].sort()

describe('OpenClaw session discovery', () => {
  it('walks only each agent sessions tree on this host', async () => {
    const source = AI_VAULT_AGENT_SOURCES.openclaw
    const files = await walkSessionFiles(agentsDir, 'openclaw', [], {
      extensions: new Set(source.extensions),
      filePredicate: source.filePredicate,
      directoryPredicate: source.directoryPredicate
    })

    expect(relativeToAgents(files)).toEqual(EXPECTED)
  })

  it('never lists an embedded agent home over a remote filesystem', async () => {
    const readDirs: string[] = []
    const provider: RemoteScannerContext['provider'] = {
      readDir: async (dirPath) => {
        readDirs.push(dirPath)
        const entries = await readdir(dirPath, { withFileTypes: true })
        return entries.map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isSymlink: entry.isSymbolicLink()
        }))
      },
      stat: async (path) => {
        const info = await stat(path)
        return { size: info.size, type: 'file', mtime: info.mtimeMs }
      },
      readFile: async () => ({ content: '', isBinary: false })
    }
    const hostPlatform = getRemoteHostPlatform(
      process.platform === 'win32' ? 'win32-x64' : 'linux-x64'
    )
    const source = remoteSessionSources(home, hostPlatform).find(
      (candidate) => candidate.agent === 'openclaw'
    )

    const context: RemoteScannerContext = {
      provider,
      executionHostId: 'ssh:host',
      hostPlatform,
      titleCaches: new Map(),
      antigravityWorkspaceResolver: { enrich: async (session) => session }
    }
    expect(source).toBeDefined()
    const candidates = source
      ? await discoverRemoteSourceCandidates({ source, context, issues: [] })
      : []

    expect(relativeToAgents(candidates.map(({ file }) => file.path))).toEqual(EXPECTED)
    expect(readDirs.some((dir) => dir.includes('codex-home'))).toBe(false)
  })
})

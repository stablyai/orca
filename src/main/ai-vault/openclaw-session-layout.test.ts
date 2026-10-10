import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

})

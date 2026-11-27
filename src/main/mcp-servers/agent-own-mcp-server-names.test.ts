import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { agentOwnMcpServerNames } from './agent-own-mcp-server-names'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('the server names an agent already uses', () => {
  it('counts an entry Orca can’t carry, so a same-named server from Orca never merges into it', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-names-'))
    dirs.push(home)
    const codexHome = join(home, '.codex')
    mkdirSync(codexHome)
    // `env_vars` is a Codex field Orca doesn't import; a url merged into this stdio entry stops Codex.
    writeFileSync(
      join(codexHome, 'config.toml'),
      '[mcp_servers.pg]\ncommand = "pg-mcp"\nenv_vars = ["DATABASE_URL"]\n'
    )
    expect(
      await agentOwnMcpServerNames('codex', { CODEX_HOME: codexHome }, join(home, 'repo'))
    ).toEqual(['pg'])
  })
})

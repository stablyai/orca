import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createClaudeModelCatalogProbe } from './claude-model-catalog-probe'
import { resolveStructuredAgentCommand } from '../../native-chat/structured-agent-command-resolution'

const AUTH_POLICY = { account: 'system' } as const

const HOME = (path: string): { variable: string; path: string } => ({
  variable: 'CLAUDE_CONFIG_DIR',
  path
})

function probeDeps(command = `"${process.execPath}"`): {
  resolveCommand: () => { command: string; prefixArgs: string[] }
  resolveEnv: () => Record<string, string>
  resolveInheritedEnv: () => Promise<Record<string, string>>
  resolveAuthPolicy: () => typeof AUTH_POLICY
} {
  return {
    resolveCommand: () =>
      resolveStructuredAgentCommand('claude', {
        agentCmdOverrides: { claude: command }
      }),
    resolveEnv: () => ({ ANTHROPIC_MODEL_GATEWAY: 'https://gateway.example' }),
    resolveInheritedEnv: async () => ({ PATH: '/resolved/bin', HOME: '/homes/user' }),
    resolveAuthPolicy: () => AUTH_POLICY
  }
}

describe('Claude catalog availability', () => {
  it('says the CLI is missing when the resolved executable is not there', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'orca-claude-missing-'))
    try {
      const missing = join(folder, 'claude with spaces', 'claude')
      const probe = createClaudeModelCatalogProbe({
        ...probeDeps(),
        resolveCommand: () => ({ command: missing, prefixArgs: [] })
      })
      await expect(probe(HOME('/homes/a'))).rejects.toMatchObject({
        unavailable: { reason: 'cliMissing' }
      })
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

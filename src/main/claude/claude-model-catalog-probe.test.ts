import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROVIDER_STDIN_END_GRACE_MS } from '../provider-process/provider-process-supervisor'
import { createClaudeModelCatalogProbe } from './claude-model-catalog-probe'
import { resolveStructuredAgentCommand } from '../native-chat/structured-agent-command-resolution'

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

describe('claude model catalog probe', () => {
  it.runIf(process.platform !== 'win32')(
    'lists through a supervised one-shot that answers after its input ends',
    async () => {
      const folder = mkdtempSync(join(tmpdir(), 'orca-claude-probe-'))
      try {
        const parentFile = join(folder, 'parent-pid')
        const standIn = join(folder, 'claude')
        // Delay beyond the stdin-end grace to verify supervised one-shot lifetime.
        writeFileSync(
          standIn,
          `#!${process.execPath}
let input = ''
process.stdin.on('data', (chunk) => (input += chunk))
process.stdin.on('end', () => setTimeout(() => {
  require('node:fs').writeFileSync(${JSON.stringify(parentFile)}, String(process.ppid))
  const request = JSON.parse(input.trim().split('\\n').find(line => line.includes('list_models')))
  if (request.request.subtype !== 'list_models') process.exit(2)
  console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success',
    request_id: request.request_id, response: { models: [{ value: 'sonnet', displayName: 'Sonnet' }] } } }))
}, ${PROVIDER_STDIN_END_GRACE_MS * 1.5}))
`
        )
        chmodSync(standIn, 0o755)
        const probe = createClaudeModelCatalogProbe({
          ...probeDeps(),
          resolveCommand: () => ({ command: standIn, prefixArgs: [] }),
          resolveInheritedEnv: async () => ({ PATH: process.env.PATH ?? '', HOME: folder })
        })

        await expect(probe(HOME(join(folder, 'account')))).resolves.toMatchObject({
          origin: 'probe',
          models: [{ id: 'sonnet', label: 'Sonnet' }]
        })
        expect(Number(readFileSync(parentFile, 'utf8'))).not.toBe(process.pid)
      } finally {
        rmSync(folder, { recursive: true, force: true })
      }
    }
  )
})

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

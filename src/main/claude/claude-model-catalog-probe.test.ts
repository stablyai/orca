import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROVIDER_STDIN_END_GRACE_MS } from '../provider-process/provider-process-supervisor'
import { createClaudeModelCatalogProbe } from './claude-model-catalog-probe'
import { resolveStructuredAgentCommand } from '../native-chat/structured-agent-command-resolution'
import type { runAgentModelCatalogListing } from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'

type ListingCall = Parameters<typeof runAgentModelCatalogListing>

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

const LISTED = `${JSON.stringify({
  type: 'control_response',
  response: {
    subtype: 'success',
    request_id: 'orca-model-discovery',
    response: {
      models: [
        {
          value: 'sonnet',
          displayName: 'Sonnet',
          supportsEffort: true,
          supportedEffortLevels: ['low']
        }
      ]
    }
  }
})}\n`

describe('claude model catalog probe', () => {
  it.each([
    [[], [], ['/orca-probe', '/orca-probe'], 'user,project,local'],
    [['node_modules/claude/cli.js'], [], ['/chat-a', '/chat-b'], 'user'],
    [[], ['--settings', 'settings.json'], ['/chat-a', '/chat-b'], 'user']
  ])(
    'lists prefix %j with arguments %j from %j, reading %s settings',
    async (prefixArgs, launchArgs, listedIn, sources) => {
      // A user command line may name files in the chat's folder, so it runs there, but reads only
      // user settings there so the project's own settings never narrow the account's list.
      const calls: ListingCall[] = []
      const probe = createClaudeModelCatalogProbe({
        ...probeDeps(),
        resolveCommand: () => ({ command: process.execPath, prefixArgs }),
        resolveLaunchArgs: async () => launchArgs,
        runListing: async (...call) => {
          calls.push(call)
          return LISTED
        }
      })
      const identities: unknown[] = []
      for (const folder of ['/chat-a', '/chat-b']) {
        const resolved = await probe.resolve?.(
          HOME('/homes/a'),
          '/orca-probe',
          'snapshot',
          undefined,
          folder
        )
        identities.push(resolved?.identity)
        await resolved?.run()
      }
      expect(calls.map(([launch]) => launch.cwd)).toEqual(listedIn)
      const args = calls[0]?.[0].args ?? []
      expect(args.slice(0, prefixArgs.length)).toEqual(prefixArgs)
      expect(args.slice(args.length - launchArgs.length)).toEqual(launchArgs)
      expect(args[args.indexOf('--setting-sources') + 1]).toBe(sources)
      expect(JSON.stringify(identities[0]) === JSON.stringify(identities[1])).toBe(
        listedIn[0] === listedIn[1]
      )
    }
  )

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

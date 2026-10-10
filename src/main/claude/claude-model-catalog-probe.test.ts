import { AgentModelCatalogUnavailableError } from '../native-chat/agent-model-catalog/agent-model-catalog-unavailable'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PROVIDER_STDIN_END_GRACE_MS } from '../provider-process/provider-process-supervisor'
import { createClaudeModelCatalogProbe } from './claude-model-catalog-probe'
import { resolveClaudeStructuredInvocation } from './claude-structured-launch-resolution'
import { resolveStructuredAgentCommand } from '../native-chat/structured-agent-command-resolution'
import {
  AgentModelCatalogProbeError,
  type runAgentModelCatalogListing
} from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import {
  CLAUDE_MODEL_LIST_ARGS,
  CLAUDE_MODEL_LIST_STDIN
} from '../../shared/claude-model-list-probe'

type ListingCall = Parameters<typeof runAgentModelCatalogListing>

const AUTH_POLICY = { account: 'system' } as const

const HOME = (path: string): { variable: string; path: string } => ({
  variable: 'CLAUDE_CONFIG_DIR',
  path
})

function probeDeps(command = `"${process.execPath}"`): {
  resolveCommand: () => string
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
  it.each([`"${process.execPath}"`, ''])(
    'lists with the session executable and env for Command %j',
    async (command) => {
      const deps = probeDeps(command)
      const calls: ListingCall[] = []
      const probe = createClaudeModelCatalogProbe({
        ...deps,
        runListing: async (...call) => {
          calls.push(call)
          return LISTED
        }
      })
      const success = await probe(HOME('/homes/account-a'))
      expect(success.origin).toBe('probe')
      expect(success.models).toEqual([
        {
          id: 'sonnet',
          label: 'Sonnet',
          isDefault: false,
          // The parser's thinking default is not what Claude runs; naming it would label the effort.
          efforts: [{ value: 'low', label: 'Low' }]
        }
      ])
      // The probe's env is exactly the session launch's resolved env for the same deps, plus the
      // account pin, and the listing runs the resolved binary, never the bare spec name.
      const invocation = await resolveClaudeStructuredInvocation(deps, (env) => ({
        ...env,
        CLAUDE_CONFIG_DIR: '/homes/account-a'
      }))
      expect(calls).toHaveLength(1)
      const [launch, options] = calls[0]!
      expect(launch).toEqual({
        command: invocation.command,
        args: [...CLAUDE_MODEL_LIST_ARGS],
        stdin: CLAUDE_MODEL_LIST_STDIN
      })
      expect(options.inheritedEnv).toEqual(invocation.env)
    }
  )

  it('pins no CLAUDE_CONFIG_DIR for the CLI default home, exactly as a session spawn does', async () => {
    const envs: (NodeJS.ProcessEnv | undefined)[] = []
    const probe = createClaudeModelCatalogProbe({
      ...probeDeps(),
      runListing: async (_launch, options) => {
        envs.push(options.inheritedEnv)
        return LISTED
      }
    })
    await probe(HOME(join(homedir(), '.claude')))
    await probe(HOME('/homes/account-a'))
    // An explicit default would move the CLI off its default Keychain item (claude.ai OAuth).
    expect(envs[0]).not.toHaveProperty('CLAUDE_CONFIG_DIR')
    expect(envs[1]).toMatchObject({ CLAUDE_CONFIG_DIR: '/homes/account-a' })
  })

  it('refuses an answer that names no model, as an older CLI gives, rather than store it', async () => {
    const probe = createClaudeModelCatalogProbe({
      ...probeDeps(),
      runListing: async () =>
        `${JSON.stringify({ type: 'control_response', response: { subtype: 'error' } })}\n`
    })
    await expect(probe(HOME('/homes/a'))).rejects.toThrow(/listed no models/)
  })

  it.each(['npx claude', 'claude --verbose', '/missing/claude', './claude'])(
    'lists nothing, and never probes the stock CLI, for Command %s',
    async (command) => {
      const runListing = vi.fn()
      const probe = createClaudeModelCatalogProbe({ ...probeDeps(command), runListing })
      await expect(probe(HOME('/homes/a'))).rejects.toMatchObject({
        reason: 'agentCommandNotRunnable'
      })
      expect(runListing).not.toHaveBeenCalled()
    }
  )

  it.runIf(process.platform !== 'win32')(
    'lists through a supervised one-shot that answers after its input ends',
    async () => {
      const folder = mkdtempSync(join(tmpdir(), 'orca-claude-probe-'))
      try {
        const parentFile = join(folder, 'parent-pid')
        const standIn = join(folder, 'claude')
        // Answers only after the session stdin-end grace, the way a slow `claude -p` does.
        writeFileSync(
          standIn,
          `#!${process.execPath}
let input = ''
process.stdin.on('data', (chunk) => (input += chunk))
process.stdin.on('end', () => setTimeout(() => {
  require('node:fs').writeFileSync(${JSON.stringify(parentFile)}, String(process.ppid))
  const request = JSON.parse(input.trim().split('\\n').at(-1))
  if (request.request.subtype !== 'list_models') process.exit(2)
  console.log(JSON.stringify({ type: 'control_response', response: { subtype: 'success',
    request_id: request.request_id, response: { models: [{ value: 'sonnet', displayName: 'Sonnet' }] } } }))
}, ${PROVIDER_STDIN_END_GRACE_MS * 1.5}))
`
        )
        chmodSync(standIn, 0o755)
        const probe = createClaudeModelCatalogProbe({
          ...probeDeps(),
          resolveCommand: () => standIn,
          resolveInheritedEnv: async () => ({ PATH: process.env.PATH ?? '', HOME: folder })
        })

        await expect(probe(HOME(join(folder, 'account')))).resolves.toMatchObject({
          origin: 'probe',
          models: [{ id: 'sonnet', label: 'Sonnet' }]
        })
        // The stand-in's parent is the supervisor, never Orca itself.
        expect(Number(readFileSync(parentFile, 'utf8'))).not.toBe(process.pid)
      } finally {
        rmSync(folder, { recursive: true, force: true })
      }
    }
  )
})

describe('Claude catalog availability', () => {
  it('does not turn a generic listing failure into unavailable', async () => {
    const probe = createClaudeModelCatalogProbe({
      ...probeDeps(),
      runListing: async () => {
        throw new AgentModelCatalogProbeError('claude did not list models', 'timeout')
      }
    })
    await expect(probe(HOME('/homes/a'))).rejects.not.toBeInstanceOf(
      AgentModelCatalogUnavailableError
    )
  })

  // Claude has no pre-send sign-in verdict: its real start refusal is the only one.
  it.each([false, true])('lists with no sign-in verdict, managed=%s', async (managed) => {
    const runListing = vi.fn(async () => LISTED)
    const probe = createClaudeModelCatalogProbe({
      ...probeDeps(),
      resolveAuthPolicy: () => ({ account: managed ? ('managed' as const) : ('system' as const) }),
      runListing
    })
    const result = await probe(HOME('/homes/a'))
    expect(result).toMatchObject({ models: [{ id: 'sonnet' }] })
    expect(result).not.toHaveProperty('unavailable')
    expect(runListing).toHaveBeenCalledTimes(1)
  })

  it('says the CLI is missing when the resolved executable is not there', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'orca-claude-missing-'))
    try {
      // Never created: the real runner's spawn reports ENOENT for this exact path.
      const missing = join(folder, 'claude with spaces', 'claude')
      const probe = createClaudeModelCatalogProbe({
        ...probeDeps(),
        resolveCommand: () => missing
      })
      await expect(probe(HOME('/homes/a'))).rejects.toMatchObject({
        unavailable: { reason: 'cliMissing' }
      })
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

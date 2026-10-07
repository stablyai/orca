import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PROVIDER_STDIN_END_GRACE_MS } from '../provider-process/provider-process-supervisor'
import { createClaudeModelCatalogProbe } from './claude-model-catalog-probe'
import { resolveClaudeStructuredInvocation } from './claude-structured-launch-resolution'
import type { discoverModelsLocal } from '../text-generation/commit-message-model-discovery'
import { resolveStructuredAgentCommand } from '../native-chat/structured-agent-command-resolution'
import type {
  SpawnedSourceControlAgentProcess,
  SpawnSourceControlAgent
} from '../text-generation/source-control-text-generation-types'

type DiscoverInput = Parameters<typeof discoverModelsLocal>[0]
type DiscoverResult = Awaited<ReturnType<typeof discoverModelsLocal>>

const AUTH_POLICY = { stripAuthEnv: false } as const

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

function listedResult(): DiscoverResult {
  return {
    success: true,
    capability: {
      id: 'claude',
      label: 'Claude',
      modelSource: 'dynamic',
      defaultModelId: 'sonnet',
      models: []
    },
    models: [
      {
        id: 'sonnet',
        label: 'Sonnet',
        isDefault: true,
        thinkingLevels: [{ id: 'low', label: 'Low' }],
        defaultThinkingLevel: 'low'
      }
    ],
    defaultModelId: 'sonnet',
    catalogOrigin: 'probe'
  }
}

describe('claude model catalog probe', () => {
  it.each([`"${process.execPath}"`, ''])(
    'lists with the session executable for Command %j',
    async (command) => {
      const deps = probeDeps(command)
      const captured: DiscoverInput[] = []
      const spawnAgent = vi.fn<SpawnSourceControlAgent>(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake discover below never reads the returned child.
        () => ({}) as SpawnedSourceControlAgentProcess
      )
      const probe = createClaudeModelCatalogProbe({
        ...deps,
        spawnAgent,
        discover: async (input) => {
          captured.push(input)
          // Drive the probe's spawn wrapper once, the way the real listing would.
          input.spawnAgent({
            binary: 'claude',
            args: ['--list'],
            env: input.env,
            stdinMode: 'ignore',
            useCwdForNative: false
          })
          return listedResult()
        }
      })
      const success = await probe('/homes/account-a')
      expect(success.origin).toBe('probe')
      expect(success.models).toEqual([
        {
          id: 'sonnet',
          label: 'Sonnet',
          isDefault: true,
          // The spec's `defaultThinkingLevel` is not what Claude runs; naming it would label the effort.
          efforts: [{ value: 'low', label: 'Low' }]
        }
      ])
      // The probe's env is exactly the session launch's resolved env for the
      // same deps, plus the account pin — and the spawn runs the resolved
      // binary, never the bare spec name.
      const invocation = await resolveClaudeStructuredInvocation(deps, (env) => ({
        ...env,
        CLAUDE_CONFIG_DIR: '/homes/account-a'
      }))
      expect(captured).toHaveLength(1)
      expect(captured[0]!.env).toEqual(invocation.env)
      expect(captured[0]!.agentCommandOverride).toBeUndefined()
      expect(spawnAgent).toHaveBeenCalledTimes(1)
      expect(spawnAgent.mock.calls[0]![0].binary).toBe(invocation.command)
    }
  )

  it('pins no CLAUDE_CONFIG_DIR for the CLI default home, exactly as a session spawn does', async () => {
    const envs: DiscoverInput['env'][] = []
    const probe = createClaudeModelCatalogProbe({
      ...probeDeps(),
      discover: async (input) => {
        envs.push(input.env)
        return listedResult()
      }
    })
    await probe(join(homedir(), '.claude'))
    await probe('/homes/account-a')
    // An explicit default would move the CLI off its default Keychain item (claude.ai OAuth).
    expect(envs[0]).not.toHaveProperty('CLAUDE_CONFIG_DIR')
    expect(envs[1]).toMatchObject({ CLAUDE_CONFIG_DIR: '/homes/account-a' })
  })

  it('refuses a static-fallback answer rather than reporting it as a catalog', async () => {
    const probe = createClaudeModelCatalogProbe({
      ...probeDeps(),
      discover: async () => ({ ...listedResult(), catalogOrigin: 'spec' })
    })
    await expect(probe('/homes/a')).rejects.toThrow(/listed no models/)
  })

  it.each(['npx claude', 'claude --verbose', '/missing/claude', './claude'])(
    'lists nothing, and never probes the stock CLI, for Command %s',
    async (command) => {
      const discover = vi.fn()
      const probe = createClaudeModelCatalogProbe({ ...probeDeps(command), discover })
      await expect(probe('/homes/a')).rejects.toMatchObject({ reason: 'agentCommandNotRunnable' })
      expect(discover).not.toHaveBeenCalled()
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

        await expect(probe(join(folder, 'account'))).resolves.toMatchObject({
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

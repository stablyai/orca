import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionRecordFixture } from '../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import type { ManagedDataAccountsState } from '../../../shared/agent-accounts/managed-account-types'
import { restoreManagedDataAccountEnvironment } from '../../../shared/agent-launch/environment/managed-data-account-environment'
import { openCodeAcpAccountBinding } from '../../opencode/accounts/opencode-structured-account-home'
import { createAcpStructuredLaunchResolver } from '../../runtime/agent-session/launch/structured-agent-launch-composition.test-support'
import type { AcpLaunchSpec } from './acp-launch-contract'
import { acpLaunchSpecFor } from './acp-launch-registry'

const PREAMBLE = 'You are Zorblax, a bot that runs in Orca.'

const managedAccounts = {
  list: (): ManagedDataAccountsState => ({ accounts: [], activeAccountId: null }),
  restoreOriginalEnvironment: (environment: Record<string, string | undefined>) =>
    restoreManagedDataAccountEnvironment(environment),
  environmentForAccount: () => ({})
}

const SPECS = {
  grok: acpLaunchSpecFor('grok')!,
  opencode: {
    ...acpLaunchSpecFor('opencode')!,
    account: openCodeAcpAccountBinding(() => managedAccounts)
  },
  omp: acpLaunchSpecFor('omp')!,
  antigravity: acpLaunchSpecFor('antigravity')!
}

const ACCOUNT_HOMES: Record<keyof typeof SPECS, AgentSessionRecord['accountHome']> = {
  grok: { variable: 'GROK_HOME', path: '/home/user/.grok' },
  opencode: { kind: 'opencode', locator: { kind: 'unmanaged' } },
  omp: { variable: 'PI_CODING_AGENT_DIR', path: '/home/user/.omp/agent' },
  antigravity: { variable: 'GEMINI_HOME', path: '/home/user/orca-data/antigravity-chat' }
}

let dataDirectory = ''
beforeAll(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), 'acp-instructions-'))
})
afterAll(async () => {
  await rm(dataDirectory, { recursive: true, force: true })
})

function launch(
  agent: keyof typeof SPECS,
  options: {
    instructions?: string | null
    launchEnv?: Record<string, string>
    spec?: AcpLaunchSpec
  } = {}
) {
  const record: AgentSessionRecord = {
    ...agentSessionRecordFixture(),
    provider: agent,
    providerHandleChain: [],
    accountHome: ACCOUNT_HOMES[agent]
  }
  const resolve = createAcpStructuredLaunchResolver(options.spec ?? SPECS[agent], {
    store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
    savedSession: { hasProviderTurn: async () => false },
    resolveWorkspacePath: async () => '/home/user/.orca/bots/zorblax',
    resolveEnvironment: async () => ({ PATH: '/usr/bin', HOME: '/home/user' }),
    resolveLaunchEnv: () => options.launchEnv ?? {},
    resolveCommand: (command) => `/resolved/${command}`,
    inheritedEnv: {},
    dataDirectory,
    probeVersion: async () => ({ version: agent === 'omp' ? '17.2.9' : '1.18.35' }),
    ...(options.instructions === undefined
      ? {}
      : { resolveInstructions: async () => options.instructions ?? null })
  })
  return resolve({
    identity: {
      sessionId: `session-${agent}`,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent,
      providerHandle: null
    }
  })
}

describe('ACP launch: standing instructions', () => {
  it('gives Grok them as rules on its new session', async () => {
    const resolved = await launch('grok', { instructions: PREAMBLE })
    expect(resolved.sessionMeta).toEqual({ rules: PREAMBLE })
  })

  it("appends them to Antigravity's system prompt", async () => {
    const resolved = await launch('antigravity', { instructions: PREAMBLE })
    expect(resolved.sessionMeta).toEqual({
      antigravity: { systemPrompt: { append: PREAMBLE } }
    })
  })

  it("adds them to OpenCode's inline instructions after the user's own, keeping their settings", async () => {
    const mine = JSON.stringify({ model: 'x/y', instructions: ['/home/user/mine.md'] })
    const resolved = await launch('opencode', {
      instructions: PREAMBLE,
      launchEnv: { OPENCODE_CONFIG_CONTENT: mine }
    })
    const config = JSON.parse(resolved.env.OPENCODE_CONFIG_CONTENT ?? '')
    expect(config).toMatchObject({ model: 'x/y' })
    expect(config.instructions).toHaveLength(2)
    expect(config.instructions[0]).toBe('/home/user/mine.md')
    await expectPrivateFile(config.instructions[1])
  })

  it("refuses to start OpenCode when the user's inline configuration cannot be extended", async () => {
    await expect(
      launch('opencode', {
        instructions: PREAMBLE,
        launchEnv: { OPENCODE_CONFIG_CONTENT: '{ // jsonc\n}' }
      })
    ).rejects.toThrow(/cannot take this chat's standing instructions/)
  })

  it('appends them to OMP’s system prompt from a file', async () => {
    const resolved = await launch('omp', { instructions: PREAMBLE })
    const [base, flag] = [resolved.args.slice(0, -1), resolved.args.at(-1) ?? '']
    expect(base).toEqual((await launch('omp')).args)
    expect(flag).toMatch(/^--append-system-prompt=/)
    await expectPrivateFile(flag.slice('--append-system-prompt='.length))
  })

  it('refuses to start an agent that has no way to take them', async () => {
    const { instructions: _none, ...withoutDelivery } = SPECS.omp
    await expect(launch('omp', { instructions: PREAMBLE, spec: withoutDelivery })).rejects.toThrow(
      /cannot take this chat's standing instructions/
    )
  })
})

async function expectPrivateFile(path: string): Promise<void> {
  expect(path.startsWith(join(dataDirectory, 'acp-instructions'))).toBe(true)
  expect(await readFile(path, 'utf8')).toBe(PREAMBLE)
  if (process.platform !== 'win32') {
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  }
}

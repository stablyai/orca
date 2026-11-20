import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
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
  antigravity: acpLaunchSpecFor('antigravity')!,
  cursor: acpLaunchSpecFor('cursor')!,
  hermes: acpLaunchSpecFor('hermes')!
}

const ACCOUNT_HOMES: Record<keyof typeof SPECS, AgentSessionRecord['accountHome']> = {
  grok: { variable: 'GROK_HOME', path: '/home/user/.grok' },
  opencode: { kind: 'opencode', locator: { kind: 'unmanaged' } },
  omp: { variable: 'PI_CODING_AGENT_DIR', path: '/home/user/.omp/agent' },
  antigravity: { variable: 'GEMINI_HOME', path: '/home/user/orca-data/antigravity-chat' },
  cursor: { variable: 'CURSOR_CONFIG_DIR', path: '/home/user/.cursor' },
  hermes: { variable: 'HERMES_HOME', path: '/home/user/.hermes' }
}

const PROBED_VERSIONS: Partial<Record<keyof typeof SPECS, string>> = {
  omp: '17.2.9',
  cursor: '2026.11.19-f005e9d',
  hermes: '0.23.3'
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
    workspacePath?: string
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
    resolveWorkspacePath: async () => options.workspacePath ?? '/home/user/.orca/bots/zorblax',
    resolveEnvironment: async () => ({ PATH: '/usr/bin', HOME: '/home/user' }),
    resolveLaunchEnv: () => options.launchEnv ?? {},
    resolveCommand: (command) => `/resolved/${command}`,
    inheritedEnv: {},
    dataDirectory,
    probeVersion: async () => ({ version: PROBED_VERSIONS[agent] ?? '1.18.35' }),
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
    for (const content of ['{ // jsonc\n}', '{"instructions":"/mine.md"}']) {
      await expect(
        launch('opencode', {
          instructions: PREAMBLE,
          launchEnv: { OPENCODE_CONFIG_CONTENT: content }
        })
      ).rejects.toThrow(/cannot take this chat's standing instructions/)
    }
  })

  it('appends them to OMP’s system prompt from a file', async () => {
    const resolved = await launch('omp', { instructions: PREAMBLE })
    const [base, flag] = [resolved.args.slice(0, -1), resolved.args.at(-1) ?? '']
    expect(base).toEqual((await launch('omp')).args)
    expect(flag).toMatch(/^--append-system-prompt=/)
    await expectPrivateFile(flag.slice('--append-system-prompt='.length))
  })

  it('gives Cursor them as a rule in its folder while its new session opens', async () => {
    const workspacePath = await mkdtemp(join(dataDirectory, 'cursor-workspace-'))
    const resolved = await launch('cursor', { instructions: PREAMBLE, workspacePath })
    expect(resolved.cwd).toBe(workspacePath)
    const undo = await resolved.aroundNewSession?.(resolved.cwd)
    try {
      const path = join(workspacePath, '.cursor', 'rules', 'orca-standing-instructions.mdc')
      const lines = (await readFile(path, 'utf8')).split('\n')
      expect(lines[0]).toBe('---')
      expect(lines).toContain('alwaysApply: true')
      expect(lines.slice(-3)).toEqual(['---', PREAMBLE, ''])
      if (process.platform !== 'win32') {
        expect((await stat(path)).mode & 0o777).toBe(0o600)
      }
    } finally {
      await undo?.()
    }
    expect(await readdir(workspacePath)).toEqual([])
  })

  it("writes them to Hermes's .hermes.md in the folder it runs in, rewriting it at each launch", async () => {
    const home = await mkdtemp(join(tmpdir(), 'acp-instructions-hermes-'))
    try {
      const first = await launch('hermes', { instructions: 'first preamble', workspacePath: home })
      expect(first.args).toEqual((await launch('hermes', { workspacePath: home })).args)
      expect(first.sessionMeta).toBeUndefined()
      await launch('hermes', { instructions: PREAMBLE, workspacePath: home })
      const written = await readFile(join(home, '.hermes.md'), 'utf8')
      expect(written).toContain(PREAMBLE)
      expect(written).not.toContain('first preamble')
      expect((await readdir(home)).sort()).toEqual(['.hermes.md'])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
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

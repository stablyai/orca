import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
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
import { deliverCopilotInstructions } from './acp-instructions'

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
  hermes: acpLaunchSpecFor('hermes')!,
  copilot: acpLaunchSpecFor('copilot')!
}

const ACCOUNT_HOMES: Record<keyof typeof SPECS, AgentSessionRecord['accountHome']> = {
  grok: { variable: 'GROK_HOME', path: '/home/user/.grok' },
  opencode: { kind: 'opencode', locator: { kind: 'unmanaged' } },
  omp: { variable: 'PI_CODING_AGENT_DIR', path: '/home/user/.omp/agent' },
  antigravity: { variable: 'GEMINI_HOME', path: '/home/user/orca-data/antigravity-chat' },
  cursor: { variable: 'CURSOR_CONFIG_DIR', path: '/home/user/.cursor' },
  hermes: { variable: 'HERMES_HOME', path: '/home/user/.hermes' },
  copilot: { variable: 'COPILOT_HOME', path: '/home/user/.copilot' }
}

const PROBED_VERSIONS: Partial<Record<keyof typeof SPECS, string>> = {
  omp: '17.2.9',
  cursor: '2026.11.19-f005e9d',
  hermes: '0.23.3',
  copilot: '1.0.114'
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
    version?: string
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
    probeVersion: async () => ({ version: options.version ?? PROBED_VERSIONS[agent] ?? '1.18.35' }),
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

  it("gives OpenCode 2.x them after the user's own global AGENTS.md, in a config folder linking the rest of theirs", async () => {
    const xdg = join(dataDirectory, 'opencode-xdg')
    const config = join(xdg, 'opencode')
    const source = process.platform === 'win32' ? config : join(dataDirectory, 'opencode-dotfiles')
    await mkdir(join(source, 'agents'), { recursive: true })
    await writeFile(join(source, 'agents', 'reviewer.md'), 'Review changes.')
    await writeFile(join(source, 'opencode.json'), '{"permissions":[]}')
    await writeFile(join(source, 'AGENTS.md'), 'Mine.\n')
    if (process.platform !== 'win32') {
      await mkdir(xdg)
      await symlink(source, config, 'dir')
    }
    const mine = JSON.stringify({ model: 'x/y' })
    const resolved = await launch('opencode', {
      instructions: PREAMBLE,
      version: '2.0.14',
      launchEnv: { XDG_CONFIG_HOME: xdg, OPENCODE_CONFIG_CONTENT: mine }
    })
    const configDir = resolved.env.OPENCODE_CONFIG_DIR ?? ''
    expect(configDir.startsWith(join(dataDirectory, 'acp-instructions-folders'))).toBe(true)
    expect(await readFile(join(configDir, 'AGENTS.md'), 'utf8')).toBe(`Mine.\n\n${PREAMBLE}\n`)
    expect(await readFile(join(configDir, 'opencode.json'), 'utf8')).toBe('{"permissions":[]}')
    expect(await readFile(join(configDir, 'agents', 'reviewer.md'), 'utf8')).toBe('Review changes.')
    if (process.platform !== 'win32') {
      expect((await lstat(join(configDir, 'opencode.json'))).isSymbolicLink()).toBe(true)
      expect(await readlink(join(configDir, 'opencode.json'))).toBe(join(config, 'opencode.json'))
      expect((await stat(configDir)).mode & 0o777).toBe(0o700)
    }
    expect(resolved.env.OPENCODE_CONFIG_CONTENT).toBe(mine)
    // The user's own folder is left as it was.
    expect(await readFile(join(source, 'AGENTS.md'), 'utf8')).toBe('Mine.\n')
  })

  it("keeps a lowercase-named global agents.md of the user's out of the generated file's write path", async () => {
    const source = join(dataDirectory, 'opencode-lowercase-agents')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'agents.md'), 'Mine.\n')
    const resolved = await launch('opencode', {
      instructions: PREAMBLE,
      version: '2.0.14',
      launchEnv: { OPENCODE_CONFIG_DIR: source }
    })
    const configDir = resolved.env.OPENCODE_CONFIG_DIR ?? ''
    expect(await readFile(join(source, 'agents.md'), 'utf8')).toBe('Mine.\n')
    expect(await readFile(join(configDir, 'AGENTS.md'), 'utf8')).toBe(`Mine.\n\n${PREAMBLE}\n`)
    expect((await lstat(join(configDir, 'AGENTS.md'))).isSymbolicLink()).toBe(false)
  })

  it('keeps only the newest earlier OpenCode config folder of a chat', async () => {
    const folders = new Set<string>()
    for (let i = 0; i < 4; i++) {
      const resolved = await launch('opencode', { instructions: PREAMBLE, version: '2.0.14' })
      folders.add(resolved.env.OPENCODE_CONFIG_DIR ?? '')
    }
    const alive = []
    for (const folder of folders) {
      alive.push(
        await stat(folder).then(
          () => true,
          () => false
        )
      )
    }
    expect(alive.filter(Boolean)).toHaveLength(2)
    expect(alive.slice(-2)).toEqual([true, true])
  })

  it('writes only the preamble when the explicitly configured OpenCode folder is missing', async () => {
    const xdg = join(dataDirectory, 'other-opencode-xdg')
    await mkdir(join(xdg, 'opencode'), { recursive: true })
    await writeFile(join(xdg, 'opencode', 'AGENTS.md'), 'Unselected instructions.')
    const resolved = await launch('opencode', {
      instructions: PREAMBLE,
      version: '2.1.0',
      launchEnv: { XDG_CONFIG_HOME: xdg, OPENCODE_CONFIG_DIR: join(dataDirectory, 'missing') }
    })
    const configDir = resolved.env.OPENCODE_CONFIG_DIR ?? ''
    expect(await readdir(configDir)).toEqual(['AGENTS.md'])
    expect(await readFile(join(configDir, 'AGENTS.md'), 'utf8')).toBe(`${PREAMBLE}\n`)
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
      const agentsPath = join(home, 'AGENTS.md')
      const contextPath = join(home, '.hermes.md')
      const instructions = `---\ntitle: bot\n---\n${PREAMBLE}`
      const priorInstructions =
        'The previous set of standing instructions is intentionally longer than the replacement.'
      await writeFile(agentsPath, 'Workspace instructions')
      const first = await launch('hermes', { instructions: priorInstructions, workspacePath: home })
      expect(first.args).toEqual((await launch('hermes', { workspacePath: home })).args)
      expect(first.sessionMeta).toBeUndefined()
      expect(await readFile(contextPath, 'utf8')).toContain(priorInstructions)

      await launch('hermes', { instructions, workspacePath: home })

      const written = await readFile(contextPath, 'utf8')
      expect(written).toMatch(/^<!--[^\n]+-->\n\n/)
      expect(written.slice(written.indexOf('\n\n') + 2)).toBe(`${instructions}\n`)
      expect(await readFile(agentsPath, 'utf8')).toBe('Workspace instructions')
      expect((await readdir(home)).sort()).toEqual(['.hermes.md', 'AGENTS.md'])
      if (process.platform !== 'win32') {
        expect((await stat(contextPath)).mode & 0o777).toBe(0o600)
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it("gives Copilot them as an always-applied instructions file in a folder of the chat's own", async () => {
    const resolved = await launch('copilot', { instructions: PREAMBLE })
    const dir = resolved.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS ?? ''
    expect(dir.startsWith(join(dataDirectory, 'acp-instructions'))).toBe(true)
    const path = join(dir, '.github', 'instructions', 'orca.instructions.md')
    expect(await readFile(path, 'utf8')).toBe(`---\napplyTo: "**"\n---\n${PREAMBLE}\n`)
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    }
    expect(resolved.args).toEqual((await launch('copilot')).args)
  })

  it("keeps the user's own Copilot instruction folders ahead of Orca's", async () => {
    const resolved = await launch('copilot', {
      instructions: PREAMBLE,
      launchEnv: { COPILOT_CUSTOM_INSTRUCTIONS_DIRS: '/home/user/mine,/home/user/team' }
    })
    const dirs = (resolved.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS ?? '').split(',')
    expect(dirs.slice(0, 2)).toEqual(['/home/user/mine', '/home/user/team'])
    expect(dirs).toHaveLength(3)
  })

  it('refuses Copilot instructions in a folder whose path has a comma, which its list would split', async () => {
    const delivered = await deliverCopilotInstructions({
      text: PREAMBLE,
      env: {},
      cwd: '/home/user/bot',
      file: async () => '/unused',
      folder: async () => '/home/user/Orca, Inc/acp-instructions/chat',
      emptyFolder: async () => '/unused',
      version: null
    })
    expect(delivered).toBeNull()
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

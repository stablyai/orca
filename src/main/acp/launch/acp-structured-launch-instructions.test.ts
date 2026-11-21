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
import type { AcpStructuredConnection } from '../process/acp-structured-connection'
import type { AcpLaunchSpec } from './acp-launch-contract'
import { acpLaunchSpecFor } from './acp-launch-registry'
import { deliverCopilotInstructions, deliverOpenCodeInstructions } from './acp-instructions'
import { acpReleaseWithChild } from './acp-structured-launch-preparation'

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
  copilot: acpLaunchSpecFor('copilot')!,
  kimi: acpLaunchSpecFor('kimi')!,
  kiro: acpLaunchSpecFor('kiro')!,
  goose: acpLaunchSpecFor('goose')!,
  kilo: acpLaunchSpecFor('kilo')!,
  'mimo-code': acpLaunchSpecFor('mimo-code')!,
  gemini: acpLaunchSpecFor('gemini')!,
  'qwen-code': acpLaunchSpecFor('qwen-code')!,
  dsh: acpLaunchSpecFor('dsh')!
}

const ACCOUNT_HOMES: Record<keyof typeof SPECS, AgentSessionRecord['accountHome']> = {
  grok: { variable: 'GROK_HOME', path: '/home/user/.grok' },
  opencode: { kind: 'opencode', locator: { kind: 'unmanaged' } },
  omp: { variable: 'PI_CODING_AGENT_DIR', path: '/home/user/.omp/agent' },
  antigravity: { variable: 'GEMINI_HOME', path: '/home/user/orca-data/antigravity-chat' },
  cursor: { variable: 'CURSOR_CONFIG_DIR', path: '/home/user/.cursor' },
  hermes: { variable: 'HERMES_HOME', path: '/home/user/.hermes' },
  copilot: { variable: 'COPILOT_HOME', path: '/home/user/.copilot' },
  kimi: { variable: 'KIMI_CODE_HOME', path: '/home/user/.kimi-code' },
  kiro: { variable: 'KIRO_HOME', path: '/home/user/.kiro' },
  goose: { variable: 'GOOSE_PATH_ROOT', path: '/home/user/.config/goose' },
  kilo: { variable: 'XDG_DATA_HOME', path: '/home/user/.local/share' },
  'mimo-code': { variable: 'XDG_DATA_HOME', path: '/home/user/.local/share' },
  gemini: { variable: 'GEMINI_CLI_HOME', path: '/home/user' },
  'qwen-code': { variable: 'QWEN_HOME', path: '/home/user/.qwen' },
  dsh: { variable: 'DSH_HOME', path: '/home/user/.dsh' }
}

const PROBED_VERSIONS: Partial<Record<keyof typeof SPECS, string>> = {
  omp: '17.2.9',
  cursor: '2026.11.19-f005e9d',
  hermes: '0.23.3',
  copilot: '1.0.114',
  kimi: '2.7.2',
  kiro: '3.1.0',
  goose: '1.60.2',
  kilo: '7.8.32',
  'mimo-code': '0.1.17',
  gemini: '0.70.0',
  'qwen-code': '0.28.0'
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

  it('gives Kiro them as an always-included steering document on its new session', async () => {
    const resolved = await launch('kiro', { instructions: PREAMBLE })
    expect(resolved.sessionMeta).toEqual({
      kiro: { steering: [{ name: 'orca', inclusion: 'always', content: PREAMBLE }] }
    })
    expect(resolved.sessionMetaOnReopen).toBeUndefined()
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

  it.each([
    ['kilo', 'KILO_CONFIG_CONTENT'],
    ['mimo-code', 'MIMOCODE_CONFIG_CONTENT']
  ] as const)(
    "adds them to the OpenCode fork %s's inline instructions after the user's own",
    async (agent, variable) => {
      const mine = JSON.stringify({ model: 'x/y', instructions: ['/home/user/mine.md'] })
      const resolved = await launch(agent, {
        instructions: PREAMBLE,
        launchEnv: { [variable]: mine }
      })
      const config = JSON.parse(resolved.env[variable] ?? '')
      expect(config).toMatchObject({ model: 'x/y' })
      expect(config.instructions[0]).toBe('/home/user/mine.md')
      await expectPrivateFile(config.instructions[1])
      expect(resolved.env.OPENCODE_CONFIG_CONTENT).toBeUndefined()
    }
  )

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
    const foldsCase = await readFile(join(source, 'AGENTS.md'), 'utf8').then(
      () => true,
      () => false
    )
    expect(await readFile(join(configDir, 'AGENTS.md'), 'utf8')).toBe(
      `${foldsCase ? 'Mine.\n\n' : ''}${PREAMBLE}\n`
    )
    expect((await lstat(join(configDir, 'AGENTS.md'))).isSymbolicLink()).toBe(false)
    expect((await readdir(configDir)).sort()).toEqual(
      foldsCase ? ['AGENTS.md'] : ['AGENTS.md', 'agents.md']
    )
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
      const rules = join(workspacePath, '.cursor', 'rules')
      const [name] = await readdir(rules)
      expect(name).toMatch(/^orca-standing-instructions-.+\.mdc$/)
      const path = join(rules, name)
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

  it("writes them to Goose's .goosehints in the folder it runs in", async () => {
    const home = await mkdtemp(join(tmpdir(), 'acp-instructions-goose-'))
    try {
      const resolved = await launch('goose', { instructions: PREAMBLE, workspacePath: home })
      expect(resolved.args).toEqual((await launch('goose', { workspacePath: home })).args)
      const written = await readFile(join(home, '.goosehints'), 'utf8')
      expect(written).toBe(
        `<!-- Orca writes this file for Goose chats in this folder; edits are replaced. -->\n\n${PREAMBLE}\n`
      )
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it.each([
    ['hermes', '.hermes.md'],
    ['qwen-code', 'QWEN.md']
  ] as const)(
    "writes them to %s's %s in the folder it runs in, rewriting it at each launch",
    async (agent, contextFile) => {
      const home = await mkdtemp(join(tmpdir(), `acp-instructions-${agent}-`))
      try {
        const agentsPath = join(home, 'AGENTS.md')
        const contextPath = join(home, contextFile)
        const instructions = `---\ntitle: bot\n---\n${PREAMBLE}`
        const priorInstructions =
          'The previous set of standing instructions is intentionally longer than the replacement.'
        await writeFile(agentsPath, 'Workspace instructions')
        const first = await launch(agent, { instructions: priorInstructions, workspacePath: home })
        expect(first.args).toEqual((await launch(agent, { workspacePath: home })).args)
        expect(first.sessionMeta).toBeUndefined()
        expect(await readFile(contextPath, 'utf8')).toContain(priorInstructions)

        await launch(agent, { instructions, workspacePath: home })

        const written = await readFile(contextPath, 'utf8')
        expect(written).toMatch(/^<!--[^\n]+-->\n\n/)
        expect(written.slice(written.indexOf('\n\n') + 2)).toBe(`${instructions}\n`)
        expect(await readFile(agentsPath, 'utf8')).toBe('Workspace instructions')
        expect((await readdir(home)).sort()).toEqual([contextFile, 'AGENTS.md'].sort())
        if (process.platform !== 'win32') {
          expect((await stat(contextPath)).mode & 0o777).toBe(0o600)
        }
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    }
  )

  it("writes them into DSH's own AGENTS.md, keeping the text the user already had there", async () => {
    const home = await mkdtemp(join(tmpdir(), 'acp-instructions-dsh-'))
    try {
      const agentsPath = join(home, 'AGENTS.md')
      await writeFile(agentsPath, 'Workspace instructions')
      const resolved = await launch('dsh', { instructions: PREAMBLE, workspacePath: home })
      expect(resolved.args).toEqual(['--profile', 'acp'])

      const written = await readFile(agentsPath, 'utf8')
      expect(written).toMatch(/^Workspace instructions/)
      expect(written).toContain(`<!-- orca:begin -->\n${PREAMBLE}\n<!-- orca:end -->`)

      await launch('dsh', {
        instructions: 'The replacement set of standing instructions.',
        workspacePath: home
      })
      const rewritten = await readFile(agentsPath, 'utf8')
      expect(rewritten).toContain('Workspace instructions')
      expect(rewritten).not.toContain(PREAMBLE)
      expect(rewritten.match(/<!-- orca:begin -->/g)).toHaveLength(1)

      // DSH reads this file at every start, so a launch with no instructions takes the block back
      // out instead of leaving text no launch brought. The user's own text stays.
      const bare = await launch('dsh', { workspacePath: home })
      expect(bare.args).toEqual(resolved.args)
      expect(await readFile(agentsPath, 'utf8')).toBe('Workspace instructions\n')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it("keeps the indentation the user's AGENTS.md opens with when the block goes", async () => {
    const home = await mkdtemp(join(tmpdir(), 'acp-instructions-dsh-indent-'))
    try {
      const agentsPath = join(home, 'AGENTS.md')
      const userText = '    indented first line\n\nrest of the notes'
      await writeFile(agentsPath, userText)

      await launch('dsh', { instructions: PREAMBLE, workspacePath: home })
      await launch('dsh', { workspacePath: home })

      expect(await readFile(agentsPath, 'utf8')).toBe(`${userText}\n`)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  // Windows may refuse to make the link at all, which would fail the setup, not the refusal.
  it.skipIf(process.platform === 'win32')(
    'refuses to start DSH when the file it must write is a link it will not follow',
    async () => {
      const home = await mkdtemp(join(tmpdir(), 'acp-instructions-dsh-link-'))
      try {
        const linked = join(home, 'linked-notes.md')
        await writeFile(linked, 'Workspace instructions')
        await symlink(linked, join(home, 'AGENTS.md'))

        await expect(
          launch('dsh', { instructions: PREAMBLE, workspacePath: home })
        ).rejects.toThrow(/cannot take this chat's standing instructions/)
        expect(await readFile(linked, 'utf8')).toBe('Workspace instructions')
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    }
  )

  it("leaves no AGENTS.md holding only Orca's markers", async () => {
    for (const existing of [null, '']) {
      const home = await mkdtemp(join(tmpdir(), 'acp-instructions-dsh-empty-'))
      try {
        const agentsPath = join(home, 'AGENTS.md')
        if (existing !== null) {
          await writeFile(agentsPath, existing)
        }
        await launch('dsh', { instructions: PREAMBLE, workspacePath: home })
        expect(await readFile(agentsPath, 'utf8')).toContain(PREAMBLE)

        await launch('dsh', { workspacePath: home })
        expect(await lstat(agentsPath).catch(() => null)).toBeNull()
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    }
  })

  it("writes them to Kimi's .kimi-code/AGENTS.md in the folder it runs in, beside the folder's own", async () => {
    const home = await mkdtemp(join(tmpdir(), 'acp-instructions-kimi-'))
    try {
      await writeFile(join(home, 'AGENTS.md'), 'Workspace instructions')
      await launch('kimi', { instructions: PREAMBLE, workspacePath: home })
      const written = await readFile(join(home, '.kimi-code', 'AGENTS.md'), 'utf8')
      expect(written.slice(written.indexOf('\n\n') + 2)).toBe(`${PREAMBLE}\n`)
      expect(await readFile(join(home, 'AGENTS.md'), 'utf8')).toBe('Workspace instructions')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it("writes them to Gemini's GEMINI.md in the folder it runs in, trusting it only for a launch that has them", async () => {
    const home = await mkdtemp(join(tmpdir(), 'acp-instructions-gemini-'))
    try {
      const plain = await launch('gemini', { workspacePath: home })
      expect(plain.env.GEMINI_CLI_TRUST_WORKSPACE).toBeUndefined()
      expect(await readdir(home)).toEqual([])

      const resolved = await launch('gemini', { instructions: PREAMBLE, workspacePath: home })
      expect(resolved.env.GEMINI_CLI_TRUST_WORKSPACE).toBe('true')
      const written = await readFile(join(home, 'GEMINI.md'), 'utf8')
      expect(written.slice(written.indexOf('\n\n') + 2)).toBe(`${PREAMBLE}\n`)
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

  it("removes an OpenCode 2.x launch's config folder on release, leaving the user's files", async () => {
    const source = join(dataDirectory, 'opencode-release-source')
    const folder = join(dataDirectory, 'opencode-release-folder')
    await mkdir(source, { recursive: true })
    await mkdir(folder, { recursive: true })
    await writeFile(join(source, 'opencode.json'), '{}')
    await mkdir(join(source, 'agents'))
    await writeFile(join(source, 'agents', 'reviewer.md'), 'Review.')
    const delivered = await deliverOpenCodeInstructions({
      text: PREAMBLE,
      env: { OPENCODE_CONFIG_DIR: source },
      cwd: '/unused',
      file: async () => '/unused',
      folder: async () => '/unused',
      emptyFolder: async () => folder,
      version: '2.0.14'
    })
    expect(await readdir(folder)).toContain('AGENTS.md')
    await delivered?.release?.()
    expect(await readdir(dataDirectory)).not.toContain('opencode-release-folder')
    expect(await readFile(join(source, 'opencode.json'), 'utf8')).toBe('{}')
    expect(await readFile(join(source, 'agents', 'reviewer.md'), 'utf8')).toBe('Review.')
  })

  it('releases a launch when its child exits, or at once when the connection throws', async () => {
    let released = 0
    const release = async () => {
      released += 1
    }
    let exited: Parameters<AcpStructuredConnection['onExit']>[0] = () => {}
    const connection = {
      onExit: (callback: Parameters<AcpStructuredConnection['onExit']>[0]): void => {
        exited = callback
      }
    }
    acpReleaseWithChild(() => connection, release)()
    expect(released).toBe(0)
    exited({ code: 0, signal: null, processless: false })
    expect(released).toBe(1)
    const failing = acpReleaseWithChild(() => {
      throw new Error('spawn failed')
    }, release)
    expect(failing).toThrow('spawn failed')
    expect(released).toBe(2)
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

// The installed, signed-in `copilot` CLI through Orca's ACP lane with a chat's visuals: the mount
// must be load-bearing — the write arrives as the lane's own permission request, the HTML lands in
// the chat's folder, and the reply carries the visual line — while the flag-less control cannot
// invoke the skill. Neither run may touch the account's plugin/config surface. Opt-in
// (`ORCA_REAL_COPILOT_CLI_TEST=1`); off by default because it spawns the real CLI, spends model
// turns on the signed-in account, and writes session data into that account's home.
//
// `ORCA_REAL_COPILOT_CLI_TEST=1 pnpm test src/main/acp/acp-structured-copilot-real-cli-visuals.test.ts`

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import {
  NATIVE_CHAT_SCRATCH_DIR_ENV,
  createNativeChatVisualsDelivery,
  type PrepareNativeChatVisuals
} from '../native-chat/native-chat-visuals-delivery'
import { nativeChatScratchFolderFor } from '../native-chat/native-chat-scratch-folder'
import {
  TEST_SPAWN_TOKEN,
  createAcpStructuredLaunchResolver
} from '../runtime/structured-agent-launch-composition.test-support'
import { createAcpAgentConnection } from './acp-agent-connection'
import type { AcpLaunchSpec } from './acp-launch-specs'
import type { AcpPermissionHandler } from './acp-permission-requests'
import type { AcpSessionEvent } from './acp-session-runtime'
import {
  COPILOT,
  copilotCliPresent,
  streamedReply
} from './acp-structured-copilot-real-cli.test-support'
import type { RequestPermissionRequest } from './generated/acp-protocol.generated'

const SKILL_NAME = 'orca-chat-visuals'
const SESSION_ID = 'copilot-real-cli-visuals'
const VISUAL_PROMPT =
  'Show me a bar chart of the values 3, 5 and 8 as an inline visual in this chat.'
const SKILL_NAMES_PROMPT =
  'Without using any tool, reply with exactly the names of the skills available to you whose name contains "visuals", comma separated, or NONE.'

const enabled = process.env.ORCA_REAL_COPILOT_CLI_TEST === '1' && copilotCliPresent()

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? filesUnder(path) : [path]
  })
}

/** The account's plugin/config surface: installed plugin files by path and size, config contents. */
function accountPluginSurface(home: string): Record<string, string> {
  const surface: Record<string, string> = {}
  for (const name of ['config.json', 'mcp-config.json', 'lsp-config.json']) {
    const path = join(home, name)
    surface[name] = existsSync(path) ? readFileSync(path, 'utf8') : '<missing>'
  }
  const plugins = join(home, 'installed-plugins')
  for (const path of existsSync(plugins) ? filesUnder(plugins) : []) {
    surface[relative(home, path)] = String(statSync(path).size)
  }
  return surface
}

function resolverFor(input: {
  spec: AcpLaunchSpec
  cwd: string
  prepareVisuals?: PrepareNativeChatVisuals
}) {
  const record = {
    ...agentSessionRecordFixture(),
    sessionId: SESSION_ID,
    provider: 'copilot',
    providerHandleChain: [],
    accountHome: {
      variable: 'COPILOT_HOME',
      path: join(homedir(), '.copilot')
    }
  }
  return createAcpStructuredLaunchResolver(input.spec, {
    store: { getRecord: () => record, pinLaunchDirectory: async () => record },
    readJournal: () => null,
    resolveWorkspacePath: async () => input.cwd,
    resolveEnvironment: async () => process.env,
    resolveLaunchEnv: () => ({}),
    inheritedEnv: process.env,
    ...(input.prepareVisuals ? { prepareVisuals: input.prepareVisuals } : {})
  })
}

function allowOncePermissions(): {
  requests: RequestPermissionRequest[]
  handler: AcpPermissionHandler
} {
  const requests: RequestPermissionRequest[] = []
  const handler: AcpPermissionHandler = (request) => {
    requests.push(request)
    const allow = request.options.find((option) => option.kind === 'allow_once')
    return allow
      ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
      : { outcome: { outcome: 'cancelled' } }
  }
  return { requests, handler }
}

function connect(launch: {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
  envToDelete: string[]
}) {
  const { requests, handler } = allowOncePermissions()
  const events: AcpSessionEvent[] = []
  const connection = createAcpAgentConnection(
    {
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: launch.env,
      envToDelete: launch.envToDelete
    },
    { clientInfo: { name: 'orca', version: '1' }, onPermission: handler }
  )
  onTestFinished(async () => {
    await connection.close().catch(() => {})
  })
  connection.subscribe((event) => events.push(event))
  return { connection, events, requests }
}

describe.skipIf(!enabled)('Copilot real CLI with chat visuals', () => {
  it('mounts the skill and lands the visual the lane allowed', async () => {
    const base = mkdtempSync(join(tmpdir(), 'orca-real-copilot-visuals-'))
    const cwd = join(base, 'workspace')
    const stateDirectory = join(base, 'state')
    mkdirSync(cwd)
    onTestFinished(() => rmSync(base, { recursive: true, force: true }))
    const accountHome = join(homedir(), '.copilot')
    const before = accountPluginSurface(accountHome)
    const logger = { warn: vi.fn(), error: vi.fn() }
    const identity = {
      sessionId: SESSION_ID,
      workspaceId: 'workspace-real-cli-visuals',
      hostId: 'local',
      agent: 'copilot',
      providerHandle: null
    }
    const launch = await resolverFor({
      spec: COPILOT,
      cwd,
      prepareVisuals: createNativeChatVisualsDelivery({ stateDirectory, logger })
    })({ identity, spawnToken: TEST_SPAWN_TOKEN })

    const folder = nativeChatScratchFolderFor(stateDirectory, SESSION_ID)
    expect(launch.args).toEqual([
      '--acp',
      '--stdio',
      '--plugin-dir',
      join(process.cwd(), 'resources', 'native-chat-visuals')
    ])
    expect(launch.env[NATIVE_CHAT_SCRATCH_DIR_ENV]).toBe(folder)

    const { connection, events, requests } = connect(launch)
    await connection.initialize()
    const started = await connection.start({ cwd, mcpServers: [] })
    const turn = await connection.prompt([{ type: 'text', text: VISUAL_PROMPT }])
    const reply = streamedReply(events, started.sessionId)

    const landed = (existsSync(folder) ? readdirSync(folder) : []).find((name) =>
      name.endsWith('.html')
    )
    const shown = /::orca-visual\{file="([^"]+)"/.exec(reply)?.[1]
    expect(turn.stopReason).toBe('end_turn')
    expect(landed).toBeDefined()
    expect(shown).toBe(landed)
    expect(requests.length).toBeGreaterThan(0)
    // The write arrives as the lane's own permission request, naming the file in the chat's folder.
    expect(JSON.stringify(requests)).toContain(folder)
    expect(accountPluginSurface(accountHome)).toEqual(before)
  }, 240_000)

  it('cannot invoke or name the skill without the mount', async () => {
    const base = mkdtempSync(join(tmpdir(), 'orca-real-copilot-control-'))
    const cwd = join(base, 'workspace')
    const stateDirectory = join(base, 'state')
    mkdirSync(cwd)
    onTestFinished(() => rmSync(base, { recursive: true, force: true }))
    const accountHome = join(homedir(), '.copilot')
    const before = accountPluginSurface(accountHome)
    const identity = {
      sessionId: SESSION_ID,
      workspaceId: 'workspace-real-cli-visuals',
      hostId: 'local',
      agent: 'copilot',
      providerHandle: null
    }
    // Today's shipped shape: the spec without its visuals loader (no flag, no env).
    const flagless = { ...COPILOT }
    delete flagless.visualsSkill
    const launch = await resolverFor({ spec: flagless, cwd })({
      identity,
      spawnToken: TEST_SPAWN_TOKEN
    })

    const folder = nativeChatScratchFolderFor(stateDirectory, SESSION_ID)
    expect(launch.args).toEqual(['--acp', '--stdio'])
    expect(launch.env[NATIVE_CHAT_SCRATCH_DIR_ENV]).toBeUndefined()

    const { connection, events } = connect(launch)
    await connection.initialize()
    const started = await connection.start({ cwd, mcpServers: [] })
    const first = await connection.prompt([{ type: 'text', text: VISUAL_PROMPT }])
    const visualReply = streamedReply(events, started.sessionId)
    const second = await connection.prompt([{ type: 'text', text: SKILL_NAMES_PROMPT }])
    const fullReply = streamedReply(events, started.sessionId)

    expect(first.stopReason).toBe('end_turn')
    expect(second.stopReason).toBe('end_turn')
    expect(visualReply).not.toContain('::orca-visual')
    expect(fullReply).not.toContain(SKILL_NAME)
    expect(existsSync(folder)).toBe(false)
    expect(accountPluginSurface(accountHome)).toEqual(before)
  }, 240_000)
})

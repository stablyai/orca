// Parity oracle for native-chat launches: the exact child every agent spawns, read at the spawn
// boundary, with production's own dependency wiring. A refactor of the launch path must leave the
// snapshot file unchanged.

import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type * as ProcessHostModule from '@orca/process-host'
import type { ProcessSpec } from '@orca/process-host/process-spec'
import type * as AcpAdapterModule from '../acp/acp-structured-session-adapter'
import type * as ClaudeAdapterModule from '../claude/claude-structured-session-adapter'
import type * as CodexAdapterModule from '../codex/codex-structured-session-adapter'
import type * as PiAdapterModule from '../pi/rpc-session-adapter'
import type * as ManagedProviderProcessModule from '../provider-process/managed-provider-process'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import type * as StructuredAgentSessionRuntimeModule from './structured-agent-session-runtime'
import type { StructuredAgentSessionRuntimeDeps } from './structured-agent-session-runtime'

const capture = vi.hoisted(() => {
  const pendingEnvToDelete: readonly string[] = []
  const spawns: { spec: ProcessSpec; envToDelete: readonly string[] }[] = []
  const productionDeps: StructuredAgentSessionRuntimeDeps[] = []
  const launches: unknown[] = []
  /** What an adapter's launch resolved to; some of it (permission posture) acts only after spawn. */
  const record = <T>(launch: T): T => {
    launches.push(launch)
    return launch
  }
  return { pendingEnvToDelete, spawns, productionDeps, launches, record }
})

/** Thrown in place of a real child: the start ends right where the process would begin. */
class SpawnCaptured extends Error {}

vi.mock('@orca/process-host', async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessHostModule>()
  return {
    ...actual,
    spawnProcess: (spec: ProcessSpec) => {
      capture.spawns.push({ spec, envToDelete: capture.pendingEnvToDelete })
      capture.pendingEnvToDelete = []
      throw new SpawnCaptured('spawn captured')
    }
  }
})
vi.mock('../provider-process/managed-provider-process', async (importOriginal) => {
  const actual = await importOriginal<typeof ManagedProviderProcessModule>()
  return {
    ...actual,
    spawnManagedProviderProcess: (
      launch: ProviderProcessLaunch,
      options: Parameters<typeof actual.spawnManagedProviderProcess>[1]
    ) => {
      capture.pendingEnvToDelete = launch.envToDelete ?? []
      return actual.spawnManagedProviderProcess(launch, options)
    }
  }
})
vi.mock('./structured-agent-session-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof StructuredAgentSessionRuntimeModule>()
  return {
    ...actual,
    ensureStructuredAgentSessionHost: async (deps: StructuredAgentSessionRuntimeDeps) => {
      capture.productionDeps.push(deps)
    }
  }
})
// Each adapter as production builds it, with its resolved launch recorded on the way to the spawn.
vi.mock('../codex/codex-structured-session-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof CodexAdapterModule>()
  class RecordingAdapter extends actual.CodexStructuredSessionAdapter {
    constructor(deps: ConstructorParameters<typeof actual.CodexStructuredSessionAdapter>[0]) {
      super({ ...deps, resolveLaunch: (input) => deps.resolveLaunch(input).then(capture.record) })
    }
  }
  return { ...actual, CodexStructuredSessionAdapter: RecordingAdapter }
})
vi.mock('../claude/claude-structured-session-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof ClaudeAdapterModule>()
  class RecordingAdapter extends actual.ClaudeStructuredSessionAdapter {
    constructor(deps: ConstructorParameters<typeof actual.ClaudeStructuredSessionAdapter>[0]) {
      super({ ...deps, resolveLaunch: (input) => deps.resolveLaunch(input).then(capture.record) })
    }
  }
  return { ...actual, ClaudeStructuredSessionAdapter: RecordingAdapter }
})
vi.mock('../acp/acp-structured-session-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof AcpAdapterModule>()
  class RecordingAdapter extends actual.AcpStructuredSessionAdapter {
    constructor(deps: ConstructorParameters<typeof actual.AcpStructuredSessionAdapter>[0]) {
      super({ ...deps, resolveLaunch: (input) => deps.resolveLaunch(input).then(capture.record) })
    }
  }
  return { ...actual, AcpStructuredSessionAdapter: RecordingAdapter }
})
vi.mock('../pi/rpc-session-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof PiAdapterModule>()
  class RecordingAdapter extends actual.PiRpcSessionAdapter {
    constructor(deps: ConstructorParameters<typeof actual.PiRpcSessionAdapter>[0]) {
      super({ ...deps, resolveLaunch: (input) => deps.resolveLaunch(input).then(capture.record) })
    }
  }
  return { ...actual, PiRpcSessionAdapter: RecordingAdapter }
})
vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

import { setAppEnvironment } from '../../shared/app-environment'
import { AGENT_SESSION_RECORD_SCHEMA_VERSION } from '../../shared/agent-session-record'
import type { AgentSessionAccountHome, AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionProviderHandle } from '../../shared/agent-session-provider-handle'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../shared/agent-session-provider-handle-encoding'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import {
  ORCA_SCRUB_SAFE_LAUNCH_ENV,
  ORCA_SCRUB_SAFE_PANE_ENV
} from '../../shared/agent-hook-scrub-safe-env'
import { STRUCTURED_WORKER_HANDLE_PREFIX } from '../../shared/structured-worker-handle'
import { YOLO_TUI_AGENT_ARGS } from '../../shared/tui-agent-permissions'
import {
  AGENT_HOOK_RUNTIME_ENV_KEYS,
  ORCA_AGENT_SESSION_CALLER_ENV_KEYS
} from '../ipc/pty/host-env/spawn-env-keys'
import { NATIVE_CHAT_VISUALS_DIR_ENV } from '../native-chat/native-chat-visuals-delivery'
import type { StructuredAgentSessionAcquireInput } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import { createClaudeCliFlagSupport } from '../claude/claude-cli-flag-support'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import { OrcaRuntimeService } from './orca-runtime'
import {
  STRUCTURED_AGENT_RUNTIME_REGISTRATIONS,
  type StructuredAgentAdapterContext,
  type StructuredAgentRuntimeAdapter
} from './structured-agent-runtime-registrations'
import { createStructuredAgentEnvironmentResolvers } from './structured-agent-shell-environment'
import { createStructuredAgentSessionDispatchFollowUps } from './structured-agent-session-dispatch-followups'
import {
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from './structured-worker-identity'

const AGENTS = ['claude', 'codex', 'grok', 'opencode', 'omp', 'pi'] as const
type Agent = (typeof AGENTS)[number]

/** What each fake binary prints for `--version`: a release every launch gate accepts. */
const VERSIONS: Record<Agent, string> = {
  claude: '2.1.120 (Claude Code)',
  codex: 'codex-cli 0.130.0',
  grok: '1.0.50',
  opencode: '2.0.20',
  omp: '17.1.0',
  pi: '1.1.0'
}

type LaunchCase = {
  agent: Agent
  workspace: 'worktree' | 'floating'
  start: 'fresh' | 'resumed'
  /** Registered as a dispatched worker, with the chat's visuals setting off. */
  worker: boolean
  /** Every launch setting a user can change, set away from its default. */
  configured: boolean
}

const CASES: readonly LaunchCase[] = AGENTS.flatMap((agent) => [
  ...(['worktree', 'floating'] as const).flatMap((workspace) =>
    (['fresh', 'resumed'] as const).map((start) => ({
      agent,
      workspace,
      start,
      worker: false,
      configured: false
    }))
  ),
  {
    agent,
    workspace: 'worktree' as const,
    start: 'fresh' as const,
    worker: true,
    configured: false
  }
]).concat(
  // Last, so every case before them keeps its session id.
  AGENTS.flatMap((agent) =>
    (['fresh', 'resumed'] as const).map((start) => ({
      agent,
      workspace: 'worktree' as const,
      start,
      worker: false,
      configured: true
    }))
  )
)

const SPAWN_TOKEN = 'parity-spawn-token'
const WORKSPACE_ID = 'parity-worktree'

function caseName(launch: LaunchCase): string {
  const suffix = `${launch.worker ? ' worker' : ''}${launch.configured ? ' configured' : ''}`
  return `${launch.agent} ${launch.workspace} ${launch.start}${suffix}`
}

function sessionIdFor(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
}

let root = ''
let settings: Partial<GlobalSettings> = {}
let deps: StructuredAgentSessionRuntimeDeps
const records = new Map<string, AgentSessionRecord>()
const pins: { sessionId: string; directory: string }[] = []
const savedEnv = process.env

async function writeExecutable(path: string, script: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${script}\n`)
  await chmod(path, 0o755)
}

/** A fake install: every agent's binary answers `--version`, beside a `node` (Claude's runtime). */
async function installFakeBinaries(bin: string): Promise<void> {
  await mkdir(bin, { recursive: true })
  await mkdir(join(root, 'custom-bin'), { recursive: true })
  for (const agent of AGENTS) {
    await writeExecutable(
      join(bin, agent),
      `if [ "$1" = "--version" ]; then echo "${VERSIONS[agent]}"; exit 0; fi\nexit 1`
    )
    // What a Command setting names instead of the agent's own binary.
    await writeExecutable(
      join(root, 'custom-bin', `${agent}-custom`),
      `if [ "$1" = "--version" ]; then echo "${VERSIONS[agent]}"; exit 0; fi\nexit 1`
    )
  }
  await writeExecutable(join(bin, 'node'), 'exit 0')
}

/** The settings every default case runs with. */
function defaultSettings(): Partial<GlobalSettings> {
  return {
    agentDefaultArgs: {
      claude: '--add-dir /parity/extra',
      codex: '-c model_reasoning_effort=high'
    },
    agentDefaultEnv: Object.fromEntries(AGENTS.map((agent) => [agent, { PARITY_OVERLAY: agent }])),
    nativeChatInlineVisuals: true
  } satisfies Partial<GlobalSettings>
}

/** A Command setting per agent, permissions flipped from each agent's default posture, an overlay
 *  over inherited and shell keys, and only named shell variables inherited. */
function configuredSettings(): Partial<GlobalSettings> {
  return {
    agentCmdOverrides: Object.fromEntries(
      AGENTS.map((agent) => [agent, join(root, 'custom-bin', `${agent}-custom`)])
    ),
    agentDefaultArgs: {
      claude: `${YOLO_TUI_AGENT_ARGS.claude} --add-dir /parity/configured`,
      codex: `${YOLO_TUI_AGENT_ARGS.codex} -c model_reasoning_effort=low`,
      grok: '',
      opencode: '',
      omp: '',
      pi: ''
    },
    agentDefaultEnv: Object.fromEntries(
      AGENTS.map((agent) => [
        agent,
        { PARITY_OVERLAY: `${agent}-configured`, INHERITED_ONLY: 'overlay', LANG: 'C' }
      ])
    ),
    nativeChatInheritShellEnvironment: false,
    nativeChatShellEnvironmentVariables: ['SHELL_ONLY']
  } satisfies Partial<GlobalSettings>
}

/** The live settings the host reads for `launch`. */
function settingsFor(launch: LaunchCase): Partial<GlobalSettings> {
  return {
    ...defaultSettings(),
    ...(launch.configured ? configuredSettings() : {}),
    nativeChatInlineVisuals: !launch.worker
  }
}

/** Every pane, hook, caller, handle, visuals and auth key a parent Orca pane could hand down. */
function inheritedEnvironment(): Record<string, string> {
  const env: Record<string, string> = {
    PATH: `${join(root, 'bin')}:/usr/bin:/bin`,
    HOME: join(root, 'home'),
    LANG: 'en_US.UTF-8',
    INHERITED_ONLY: 'process',
    ORCA_PANE_KEY: 'tab_parent:parent-pane',
    ORCA_TAB_ID: 'tab_parent',
    ORCA_WORKTREE_ID: 'parent-worktree',
    ORCA_AGENT_LAUNCH_TOKEN: 'parent-launch-token',
    [ORCA_SCRUB_SAFE_PANE_ENV]: 'parent-scrub-safe-pane',
    [ORCA_SCRUB_SAFE_LAUNCH_ENV]: 'parent-scrub-safe-launch',
    ORCA_TERMINAL_HANDLE: 'term_parent',
    ORCA_AGENT_SESSION_SPAWN_TOKEN: 'parent-spawn-token',
    [NATIVE_CHAT_VISUALS_DIR_ENV]: '/parent/visuals',
    ORCA_CLI_COMMAND: '/parent/orca',
    ORCA_CLI_BIN_DIR: '/parent/bin',
    ORCA_USER_DATA_PATH: '/parent/user-data',
    ORCA_OPENCODE_CONFIG_DIR: '/parent/opencode-overlay',
    ORCA_DATA_ACCOUNT_PROVIDER: 'parent-account',
    CLAUDE_CONFIG_DIR: '/parent/claude',
    CLAUDE_CODE_SESSION_ID: 'parent-claude-session',
    ANTHROPIC_API_KEY: 'parent-api-key',
    CODEX_HOME: '/parent/codex',
    NODE_OPTIONS: '--max-old-space-size=4096'
  }
  for (const key of [...AGENT_HOOK_RUNTIME_ENV_KEYS, ...ORCA_AGENT_SESSION_CALLER_ENV_KEYS]) {
    env[key] = `parent-${key.toLowerCase()}`
  }
  return env
}

function accountHomeFor(agent: Agent): AgentSessionAccountHome {
  const directory = (name: string) => join(root, 'accounts', name)
  switch (agent) {
    case 'claude':
      return { variable: 'CLAUDE_CONFIG_DIR', path: directory('claude') }
    case 'codex':
      return { variable: 'CODEX_HOME', path: directory('codex') }
    case 'grok':
      return { variable: 'GROK_HOME', path: directory('grok') }
    case 'opencode':
      return { kind: 'opencode', locator: { kind: 'unmanaged' } }
    case 'omp':
      return { variable: 'PI_CODING_AGENT_DIR', path: directory('omp') }
    case 'pi':
      return { variable: 'PI_CODING_AGENT_DIR', path: directory('pi') }
  }
}

async function resumedHandleFor(
  agent: Agent,
  sessionId: string,
  launchDirectory: string
): Promise<AgentSessionProviderHandle> {
  switch (agent) {
    case 'claude':
      return claudeProviderHandle(sessionId, '11111111-1111-4111-8111-111111111111')
    case 'codex':
      return codexProviderHandle(`thread-${sessionId}`)
    case 'pi': {
      const file = join(root, 'pi-sessions', `${sessionId}.jsonl`)
      await mkdir(join(root, 'pi-sessions'), { recursive: true })
      await writeFile(file, `${JSON.stringify({ type: 'session', cwd: launchDirectory })}\n`)
      return { transport: 'jsonl-rpc', agent: 'pi', nativeId: file }
    }
    case 'grok':
    case 'opencode':
    case 'omp':
      return { transport: 'acp', agent, nativeId: `acp-session-${sessionId}` }
  }
}

async function recordFor(
  launch: LaunchCase,
  sessionId: string
): Promise<{
  record: AgentSessionRecord
  handle: AgentSessionProviderHandle | null
}> {
  const floating = launch.workspace === 'floating'
  const directory = floating ? join(root, 'floating-pinned') : join(root, 'worktree')
  // A resumed floating chat is held to its pin; a fresh one is pinned by its first launch.
  const pinned = floating && launch.start === 'resumed'
  const handle =
    launch.start === 'resumed' ? await resumedHandleFor(launch.agent, sessionId, directory) : null
  const record: AgentSessionRecord = {
    schemaVersion: AGENT_SESSION_RECORD_SCHEMA_VERSION,
    sessionId,
    provider: launch.agent,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: floating ? FLOATING_TERMINAL_WORKTREE_ID : WORKSPACE_ID,
      workspaceKind: 'folder'
    },
    providerHandleChain: handle
      ? [
          {
            linkId: 'link-1',
            handle,
            origin: 'created',
            mintedAtFence: 1,
            observedAt: 1_000
          }
        ]
      : [],
    accountHome: accountHomeFor(launch.agent),
    ...(pinned ? { launchDirectory: directory } : {}),
    lease: {
      sessionId,
      runtimeKind: 'native',
      runtimeFence: 1,
      handoffStage: null,
      provenHandleLinkId: null,
      ownerProcess: null,
      reservedSpawnToken: SPAWN_TOKEN,
      leaseDeadlineAt: 0,
      lastRenewedAt: 0,
      handoffOperationId: null,
      journalCheckpoint: null,
      claimKeyId: 'parity-key',
      claimStatus: 'released',
      unreconciled: false,
      deathEvidence: null
    },
    createdAt: 1_000,
    updatedAt: 1_000
  }
  return { record, handle }
}

function eventSink(): StructuredAgentSessionEventSink {
  return {
    appendItem: () => {},
    appendTombstone: () => {},
    publish: () => {},
    tryAppendTransition: () => ({ accepted: true }),
    journalItems: () => null
  }
}

function adapterContext(): StructuredAgentAdapterContext {
  const store = {
    getRecord: (sessionId: string) => records.get(sessionId) ?? null,
    pinLaunchDirectory: async (sessionId: string, directory: string) => {
      pins.push({ sessionId, directory })
      const record = records.get(sessionId)
      if (record) {
        records.set(sessionId, { ...record, launchDirectory: directory })
      }
    },
    listVisibleSessionIds: () => []
  }
  return {
    deps,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a launch reads records and pins a floating directory; nothing else of the store runs before the spawn.
    store: store as unknown as AgentSessionRecordStore,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the journal is read only after a start succeeds, and every start here ends at its spawn.
    journalDatabase: { db: null } as unknown as JournalHostDatabase,
    environment: createStructuredAgentEnvironmentResolvers(deps),
    deliverLifecycle: () => {},
    followUps: createStructuredAgentSessionDispatchFollowUps({
      host: () => null,
      logger: deps.logger
    }),
    host: () => null
  }
}

const POSTURE_KEYS = new Set([
  'permissionPolicy',
  'fullAccess',
  'permissionMode',
  'allowDangerouslySkipPermissions'
])

/** A launch's permission posture: Codex's thread policy and ACP's full access act after spawn. */
function postureOf(launch: unknown): Record<string, unknown> {
  const entries = typeof launch === 'object' && launch !== null ? Object.entries(launch) : []
  const options = entries.find(([key]) => key === 'options')?.[1]
  const nested = typeof options === 'object' && options !== null ? Object.entries(options) : []
  return Object.fromEntries([...entries, ...nested].filter(([key]) => POSTURE_KEYS.has(key)))
}

/** Paths under the run's temp root and this process's own binary read the same on every run. */
function normalized(value: string): string {
  return value
    .split(root)
    .join('<root>')
    .split(process.execPath)
    .join('<node>')
    .split(process.cwd())
    .join('<repo>')
}

/** Keys whose value is the installed SDK's own, which a dependency bump changes. */
const DEPENDENCY_VALUES = new Set(['CLAUDE_AGENT_SDK_VERSION'])

function sortedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, DEPENDENCY_VALUES.has(key) ? '<dependency>' : normalized(value)])
  )
}

/** The child as the provider sees it: the supervisor's wrapper unwrapped, its spec decoded. */
function childOf(capture: { spec: ProcessSpec; envToDelete: readonly string[] }) {
  const { spec } = capture
  const env = { ...spec.env }
  const encoded = env.ORCA_PROVIDER_SUPERVISOR_SPEC
  delete env.ORCA_PROVIDER_SUPERVISOR_SPEC
  delete env.ELECTRON_RUN_AS_NODE
  const supervised = spec.args?.[0] === '-e' && encoded !== undefined
  const argv = supervised ? (spec.args ?? []).slice((spec.args ?? []).indexOf('--') + 1) : []
  const supervisor: Record<string, unknown> | null = supervised
    ? JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
    : null
  return {
    command: normalized(supervised ? (argv[0] ?? '') : spec.program),
    args: (supervised ? argv.slice(1) : (spec.args ?? [])).map(normalized),
    cwd: normalized(spec.cwd ?? ''),
    env: sortedEnv(env),
    envToDelete: [...new Set(capture.envToDelete)].sort(),
    supervisor: supervisor
      ? {
          cwd: normalized(String(supervisor.cwd)),
          closeRequest: supervisor.closeRequest,
          lifetime: supervisor.lifetime,
          nodeEnv: supervisor.nodeEnv
        }
      : null
  }
}

function installAppEnvironment(): void {
  setAppEnvironment({
    getPath: (name) => join(root, name === 'userData' ? 'user-data' : name),
    getAppPath: () => process.cwd(),
    getVersion: () => '1.0.0',
    isPackaged: () => false,
    getCliLauncherPath: () => join(root, 'orca-cli', 'bin', 'orca'),
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-launch-parity-')))
  await installFakeBinaries(join(root, 'bin'))
  // Loaded first: the SDK writes into this process's environment once, when imported.
  await import('@anthropic-ai/claude-agent-sdk')
  for (const directory of ['worktree', 'floating', 'floating-pinned', 'home', 'state']) {
    await mkdir(join(root, directory), { recursive: true })
  }
  process.env = inheritedEnvironment()
  installAppEnvironment()
  settings = defaultSettings()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host wiring reads only the store's getSettings method.
  const runtime = new OrcaRuntimeService({
    getSettings: () => settings
  } as never)
  await runtime.ensureStructuredAgentSessionHost()
  const production = capture.productionDeps.at(-1)
  if (!production) {
    throw new Error('the runtime installed no structured host')
  }
  deps = {
    ...production,
    stateDirectory: join(root, 'state'),
    logger: { warn: () => {}, error: () => {} },
    resolveWorkspacePath: async (workspaceId) =>
      join(root, workspaceId === FLOATING_TERMINAL_WORKTREE_ID ? 'floating' : 'worktree'),
    // The login shell's variables, read once per host like production's snapshot: its own PATH,
    // one variable the configured cases name and one they do not.
    resolveEnvironment: async () => ({
      PATH: `${join(root, 'bin')}:/opt/login-shell/bin:/usr/bin:/bin`,
      HOME: join(root, 'home'),
      LANG: 'en_US.UTF-8',
      SHELL_ONLY: 'shell',
      SHELL_UNLISTED: 'shell'
    }),
    // A version answered at once, so a slow machine cannot drop a version-gated flag.
    claudeCliFlags: createClaudeCliFlagSupport({
      probe: async () => VERSIONS.claude,
      keyOf: async (command, cwd) => `${command}\n${cwd}`,
      budgetMs: 60_000,
      now: () => 0
    })
  }
})

// Again after the shared setup's own per-test environment, so this app's CLI paths are the run's;
// and each case inherits the same environment whatever ran before it.
beforeEach(() => {
  installAppEnvironment()
  process.env = inheritedEnvironment()
})

afterAll(async () => {
  process.env = savedEnv
  await rm(root, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('native-chat launch parity', () => {
  it.each(CASES.map((launch, index) => [caseName(launch), launch, index] as const))(
    '%s',
    async (_name, launch, index) => {
      const registration = STRUCTURED_AGENT_RUNTIME_REGISTRATIONS.find(
        ({ definition }) => definition.agent === launch.agent
      )
      if (!registration) {
        throw new Error(`no registration for ${launch.agent}`)
      }
      const sessionId = sessionIdFor(index)
      const { record, handle } = await recordFor(launch, sessionId)
      records.set(sessionId, record)
      settings = settingsFor(launch)
      const workerHandle = `${STRUCTURED_WORKER_HANDLE_PREFIX}${sessionId}`
      if (launch.worker) {
        structuredWorkerIdentities.register({
          handle: workerHandle,
          sessionId,
          agent: launch.agent,
          paneKey: mintStructuredWorkerPaneKey(sessionId),
          processIncarnation: structuredWorkerProcessIncarnation(sessionId),
          worktreeId: WORKSPACE_ID,
          hostScope: { kind: 'local', hostId: 'local' }
        })
      }
      const adapter: StructuredAgentRuntimeAdapter = registration.createAdapter(adapterContext())
      const input: StructuredAgentSessionAcquireInput = {
        identity: {
          sessionId,
          workspaceId: record.location.workspaceId,
          hostId: 'local',
          agent: launch.agent,
          providerHandle: handle
        },
        fence: 1,
        spawnToken: SPAWN_TOKEN,
        events: eventSink()
      }
      capture.spawns.length = 0
      capture.launches.length = 0
      pins.length = 0
      try {
        const outcome = await adapter.acquire(input).then(
          () => null,
          (error: unknown) => error
        )
        expect(capture.spawns, String(outcome)).toHaveLength(1)
        expect(capture.launches).toHaveLength(1)
        const [spawn] = capture.spawns
        expect({
          child: childOf(spawn!),
          launchPosture: postureOf(capture.launches[0]),
          pinnedLaunchDirectories: pins.map(({ directory }) => normalized(directory))
        }).toMatchSnapshot()
      } finally {
        structuredWorkerIdentities.forget(workerHandle)
        await adapter.closeAll().catch(() => {})
      }
    }
  )
})

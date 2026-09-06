import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  query,
  type CanUseTool,
  type Options,
  type SDKUserMessage,
  type SpawnedProcess as SdkSpawnedProcess,
  type SpawnOptions as SdkSpawnOptions
} from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnProcess } from '../../shared/child-process/run-process'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import { claudeQuerySettingsReader } from './claude-agent-sdk-control-requests'
import { createClaudeStructuredLaunchResolver } from './claude-structured-launch-resolution'

// Contract pins for @anthropic-ai/claude-agent-sdk, run against the real SDK
// driving a scripted fake CLI (never the real Claude binary). These tests exist
// to catch a future SDK version drifting under Orca: unknown-frame pass-through,
// spawner env fidelity, argument parity with the pre-SDK argv,
// permission-callback semantics, and executable-path override.

const FAKE_CLI = join(__dirname, '__fixtures__', 'claude-agent-sdk-scripted-cli.mjs')
const SESSION_ID = '5348c19f-6a54-4c2e-9c68-9c2b1a3d4e5f'
const LEAF_UUID = 'ad0f7c9e-1b2c-4d3e-8f90-abc123def456'
const PINNED_SDK_VERSION = '0.3.251'
const SDK_PLATFORM_PACKAGE_BASENAMES = [
  'claude-agent-sdk-darwin-arm64',
  'claude-agent-sdk-darwin-x64',
  'claude-agent-sdk-linux-arm64',
  'claude-agent-sdk-linux-arm64-musl',
  'claude-agent-sdk-linux-x64',
  'claude-agent-sdk-linux-x64-musl',
  'claude-agent-sdk-win32-arm64',
  'claude-agent-sdk-win32-x64'
]

/**
 * The exact argv the hand-rolled transport built before the SDK swap. Frozen here
 * as the parity oracle: CLAUDE_STRUCTURED_BASE_OPTIONS has to keep producing it.
 */
const PRE_SDK_ARGV = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--include-partial-messages',
  '--verbose',
  '--replay-user-messages',
  '--permission-prompt-tool',
  'stdio',
  '--setting-sources',
  'user,project,local'
]

const RESULT_FRAME = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 1,
  duration_api_ms: 1,
  num_turns: 1,
  result: 'ok',
  session_id: SESSION_ID,
  total_cost_usd: 0,
  usage: { input_tokens: 1, output_tokens: 1 },
  uuid: 'uuid-result-1'
}

type ScenarioStep = Record<string, unknown>
type SpawnSeen = {
  command: string
  args: string[]
  cwd: string | undefined
  env: Record<string, string | undefined>
}
type ScriptedCliReport = {
  argv: string[]
  execPath: string
  controlRequests: { request_id: string; request: { subtype: string } }[]
  controlResponses: { response: { request_id: string; response?: Record<string, unknown> } }[]
  userMessages: Record<string, unknown>[]
}

const scratchDirs: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function scriptScenario(
  steps: ScenarioStep[],
  controlResponses: Record<string, unknown> = {}
): {
  scenarioPath: string
  reportPath: string
  cwd: string
  readReport: () => ScriptedCliReport
} {
  const dir = mkdtempSync(join(tmpdir(), 'claude-sdk-contract-'))
  scratchDirs.push(dir)
  const scenarioPath = join(dir, 'scenario.json')
  const reportPath = join(dir, 'report.json')
  writeFileSync(scenarioPath, JSON.stringify({ steps, controlResponses }))
  return {
    scenarioPath,
    reportPath,
    cwd: dir,
    readReport: () => JSON.parse(readFileSync(reportPath, 'utf8')) as ScriptedCliReport
  }
}

function scenarioEnv(scenario: { scenarioPath: string; reportPath: string }) {
  return {
    PATH: process.env.PATH,
    ORCA_SDK_CONTRACT_SCENARIO_PATH: scenario.scenarioPath,
    ORCA_SDK_CONTRACT_REPORT_PATH: scenario.reportPath
  }
}

function recordingSpawner(spawns: SpawnSeen[]) {
  return (opts: SdkSpawnOptions): SdkSpawnedProcess => {
    spawns.push({
      command: opts.command,
      args: [...opts.args],
      cwd: opts.cwd,
      env: { ...opts.env }
    })
    return spawnProcess({
      program: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env as NodeJS.ProcessEnv,
      signal: opts.signal
    }) as unknown as SdkSpawnedProcess
  }
}

function resolvedLaunch(launchArgs: string[]) {
  const record = {
    sessionId: 'contract-pin-session',
    provider: 'claude',
    location: {
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/work/.claude' },
    providerHandleChain: [],
    launchArgs
  } as unknown as AgentSessionRecord
  return createClaudeStructuredLaunchResolver({
    store: { getRecord: () => record } as unknown as AgentSessionRecordStore,
    resolveWorkspacePath: async () => '/repos/workspace-1',
    resolveCommand: () => FAKE_CLI,
    resolveAuthPolicy: () => ({ stripAuthEnv: true })
  })({ identity: { sessionId: record.sessionId } as never })
}

function singleUserTurn(): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    yield {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      parent_tool_use_id: null,
      session_id: SESSION_ID
    } as SDKUserMessage
    // Hold input open; the stream ends when the scripted CLI exits, and an
    // unresolved bare promise does not keep the event loop alive.
    await new Promise<void>(() => {})
  })()
}

async function drainQuery(options: Options): Promise<Record<string, unknown>[]> {
  const messages: Record<string, unknown>[] = []
  for await (const message of query({ prompt: singleUserTurn(), options })) {
    messages.push(message as unknown as Record<string, unknown>)
  }
  return messages
}

/** Expand `--flag=value` argv entries so both SDK spellings compare equal. */
function normalizeArgv(args: string[]): string[] {
  return args.flatMap((arg) => {
    if (!arg.startsWith('--')) {
      return [arg]
    }
    const eq = arg.indexOf('=')
    return eq === -1 ? [arg] : [arg.slice(0, eq), arg.slice(eq + 1)]
  })
}

/** Group the pre-SDK argv into flag/value pairs. */
function flagTable(args: readonly string[]): { flag: string; value: string | null }[] {
  const table: { flag: string; value: string | null }[] = []
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!
    const next = args[i + 1]
    if (next !== undefined && !next.startsWith('-')) {
      table.push({ flag, value: next })
      i++
    } else {
      table.push({ flag, value: null })
    }
  }
  return table
}

describe('Claude Agent SDK contract pins', () => {
  it('yields unknown types, unknown fields and unknown content blocks verbatim, and consumes keep_alive', async () => {
    const unknownTopLevel = {
      type: 'message_kind_from_the_future',
      session_id: SESSION_ID,
      uuid: 'uuid-unknown-1',
      payload: { alpha: 1, nested: { flags: ['a', 'b'] } }
    }
    const assistantWithUnknowns = {
      type: 'assistant',
      message: {
        id: 'msg-1',
        type: 'message',
        role: 'assistant',
        model: 'claude-x',
        content: [
          { type: 'text', text: 'hello back' },
          { type: 'content_block_from_the_future', payload: { depth: 3 } }
        ],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 2 }
      },
      parent_tool_use_id: null,
      uuid: 'uuid-assistant-1',
      session_id: SESSION_ID,
      field_from_the_future: 'preserved'
    }
    const scenario = scriptScenario([
      { awaitUserMessage: true },
      { emit: { type: 'keep_alive' } },
      { emit: unknownTopLevel },
      { emit: assistantWithUnknowns },
      { emit: RESULT_FRAME }
    ])
    const spawns: SpawnSeen[] = []
    const messages = await drainQuery({
      pathToClaudeCodeExecutable: FAKE_CLI,
      cwd: scenario.cwd,
      env: scenarioEnv(scenario),
      spawnClaudeCodeProcess: recordingSpawner(spawns)
    })

    expect(messages.find((m) => m.uuid === 'uuid-unknown-1')).toEqual(unknownTopLevel)
    expect(messages.find((m) => m.uuid === 'uuid-assistant-1')).toEqual(assistantWithUnknowns)
    // The SDK intercepts keep_alive internally — a liveness signal must never
    // be derived from it reaching the consumer, because it does not.
    expect(messages.some((m) => m.type === 'keep_alive')).toBe(false)
    expect(messages.some((m) => m.type === 'result')).toBe(true)
  })

  it('hands the custom spawner exactly the caller-supplied env, plus the two pinned SDK mutations', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'ambient-key-must-not-leak')
    const scenario = scriptScenario([{ awaitUserMessage: true }, { emit: RESULT_FRAME }])
    const spawns: SpawnSeen[] = []
    await drainQuery({
      pathToClaudeCodeExecutable: FAKE_CLI,
      cwd: scenario.cwd,
      env: {
        ...scenarioEnv(scenario),
        CLAUDE_CONFIG_DIR: '/pinned/claude-config',
        ORCA_AGENT_SESSION_SPAWN_TOKEN: 'spawn-token-1',
        NODE_OPTIONS: '--max-old-space-size=64'
      },
      spawnClaudeCodeProcess: recordingSpawner(spawns)
    })

    const env = spawns[0]!.env
    // Supplied values arrive verbatim: the config-dir pin and spawn token are
    // observable at this boundary, so Orca's auth scrubbing stays assertable.
    expect(env.CLAUDE_CONFIG_DIR).toBe('/pinned/claude-config')
    expect(env.ORCA_AGENT_SESSION_SPAWN_TOKEN).toBe('spawn-token-1')
    // Ambient process.env is NOT merged in when env is supplied.
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    // The SDK's two documented mutations, pinned so a change is noticed.
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('sdk-ts')
    expect('NODE_OPTIONS' in env).toBe(false)
  })

  it('inherits process.env into the child when env is omitted — the ambient-auth sharp edge', async () => {
    const scenario = scriptScenario([{ awaitUserMessage: true }, { emit: RESULT_FRAME }])
    vi.stubEnv('ORCA_SDK_CONTRACT_SCENARIO_PATH', scenario.scenarioPath)
    vi.stubEnv('ORCA_SDK_CONTRACT_REPORT_PATH', scenario.reportPath)
    vi.stubEnv('ORCA_SDK_CONTRACT_AMBIENT_CANARY', 'inherited-from-process-env')
    const spawns: SpawnSeen[] = []
    await drainQuery({
      pathToClaudeCodeExecutable: FAKE_CLI,
      cwd: scenario.cwd,
      spawnClaudeCodeProcess: recordingSpawner(spawns)
    })

    // Omitting env reproduces the ambient-auth-leak failure mode: the child
    // sees everything in process.env. Orca must therefore always pass an
    // explicit, fully-constructed env.
    expect(spawns[0]!.env.ORCA_SDK_CONTRACT_AMBIENT_CANARY).toBe('inherited-from-process-env')
  })

  it('emits --replay-user-messages only through extraArgs, never on its own', async () => {
    const scenario = scriptScenario([{ awaitUserMessage: true }, { emit: RESULT_FRAME }])
    const bareSpawns: SpawnSeen[] = []
    await drainQuery({
      pathToClaudeCodeExecutable: FAKE_CLI,
      cwd: scenario.cwd,
      env: scenarioEnv(scenario),
      spawnClaudeCodeProcess: recordingSpawner(bareSpawns)
    })
    expect(bareSpawns[0]!.args).not.toContain('--replay-user-messages')

    const replayScenario = scriptScenario([{ awaitUserMessage: true }, { emit: RESULT_FRAME }])
    const replaySpawns: SpawnSeen[] = []
    await drainQuery({
      pathToClaudeCodeExecutable: FAKE_CLI,
      cwd: replayScenario.cwd,
      env: scenarioEnv(replayScenario),
      extraArgs: { 'replay-user-messages': null },
      spawnClaudeCodeProcess: recordingSpawner(replaySpawns)
    })
    const replayArgs = replaySpawns[0]!.args
    expect(replayArgs.filter((arg) => arg === '--replay-user-messages')).toHaveLength(1)
  })

  it('produces a matching CLI flag for every pre-SDK argv entry', async () => {
    const scenario = scriptScenario([{ awaitUserMessage: true }, { emit: RESULT_FRAME }])
    const spawns: SpawnSeen[] = []
    // Driven by the real resolver, so the argv walk covers the durable-launchArgs
    // translation and its merge order, not a hand-written options literal.
    const launch = await resolvedLaunch(['--model', 'claude-sonnet-4-5', '--effort', 'high'])
    await drainQuery({
      ...launch.options,
      pathToClaudeCodeExecutable: FAKE_CLI,
      cwd: scenario.cwd,
      env: scenarioEnv(scenario),
      canUseTool: (async () => ({ behavior: 'deny', message: 'unused' })) as CanUseTool,
      spawnClaudeCodeProcess: recordingSpawner(spawns)
    })

    expect(spawns).toHaveLength(1)
    const argv = normalizeArgv(spawns[0]!.args)
    // Typed-first translation must not also spell the flag through extraArgs.
    for (const flag of ['--model', '--effort']) {
      expect(
        argv.filter((arg) => arg === flag),
        `${flag} occurrences`
      ).toHaveLength(1)
    }
    expect(argv[argv.indexOf('--model') + 1]).toBe('claude-sonnet-4-5')
    expect(argv[argv.indexOf('--effort') + 1]).toBe('high')
    // Headless print mode is the SDK's only mode; `query()` never passes `-p`,
    // and if the SDK ever started passing it this pin would notice.
    const impliedByHeadlessQuery = new Set(['-p'])
    for (const entry of flagTable(PRE_SDK_ARGV)) {
      if (impliedByHeadlessQuery.has(entry.flag)) {
        expect(argv, `${entry.flag} is implied, never spelled`).not.toContain(entry.flag)
        continue
      }
      const at = argv.indexOf(entry.flag)
      expect(at, `SDK argv is missing ${entry.flag}`).toBeGreaterThanOrEqual(0)
      if (entry.value !== null) {
        expect(argv[at + 1], `value of ${entry.flag}`).toBe(entry.value)
      }
    }
    // The launch resolver always carries one of --session-id / --resume.
    const sessionAt = argv.indexOf('--session-id')
    expect(sessionAt).toBeGreaterThanOrEqual(0)
    expect(argv[sessionAt + 1]).toBe(launch.providerSessionId)
  })

  it('still exposes the runtime get_settings reader the auth diagnostic depends on', async () => {
    // 0.3.251 ships getSettings() but redacts it from the Query declaration. This pin
    // is the drift alarm: if a bump drops or reshapes it, the diagnostic degrades and
    // this test says so instead of the degradation shipping silently.
    const settings = { env: { ANTHROPIC_BASE_URL: 'https://settings.example.test' } }
    const scenario = scriptScenario([{ delayMs: 3_000 }], { get_settings: settings })
    const session = query({
      prompt: singleUserTurn(),
      options: {
        pathToClaudeCodeExecutable: FAKE_CLI,
        cwd: scenario.cwd,
        env: scenarioEnv(scenario)
      }
    })
    try {
      const read = claudeQuerySettingsReader(session)
      expect(read, 'the SDK no longer exposes get_settings at runtime').not.toBeNull()
      await expect(read?.()).resolves.toEqual(settings)
    } finally {
      await session.return(undefined)
    }
  })

  it('maps resume identity to --resume and --resume-session-at', async () => {
    const scenario = scriptScenario([{ awaitUserMessage: true }, { emit: RESULT_FRAME }])
    const spawns: SpawnSeen[] = []
    await drainQuery({
      pathToClaudeCodeExecutable: FAKE_CLI,
      cwd: scenario.cwd,
      env: scenarioEnv(scenario),
      resume: SESSION_ID,
      resumeSessionAt: LEAF_UUID,
      spawnClaudeCodeProcess: recordingSpawner(spawns)
    })

    const argv = normalizeArgv(spawns[0]!.args)
    const resumeAt = argv.indexOf('--resume')
    expect(resumeAt).toBeGreaterThanOrEqual(0)
    expect(argv[resumeAt + 1]).toBe(SESSION_ID)
    const leafAt = argv.indexOf('--resume-session-at')
    expect(leafAt).toBeGreaterThanOrEqual(0)
    expect(argv[leafAt + 1]).toBe(LEAF_UUID)
  })

  it('gives canUseTool the wire request_id and fires its abort signal on control_cancel_request', async () => {
    const scenario = scriptScenario([
      { awaitUserMessage: true },
      {
        emit: {
          type: 'control_request',
          request_id: 'perm-421',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
            input: { command: 'echo hi' },
            tool_use_id: 'tool-use-9'
          }
        }
      },
      { delayMs: 120 },
      { emit: { type: 'control_cancel_request', request_id: 'perm-421' } },
      { awaitControlResponse: 'perm-421' },
      { emit: RESULT_FRAME }
    ])
    const seen: { toolName: string; requestId: string; toolUseID: string }[] = []
    let abortFired = false
    const canUseTool: CanUseTool = (toolName, _input, { signal, requestId, toolUseID }) => {
      seen.push({ toolName, requestId, toolUseID })
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          abortFired = true
          resolve({ behavior: 'deny', message: 'cancelled by test' })
        })
      })
    }
    const spawns: SpawnSeen[] = []
    await drainQuery({
      pathToClaudeCodeExecutable: FAKE_CLI,
      cwd: scenario.cwd,
      env: scenarioEnv(scenario),
      canUseTool,
      spawnClaudeCodeProcess: recordingSpawner(spawns)
    })

    expect(seen).toEqual([{ toolName: 'Bash', requestId: 'perm-421', toolUseID: 'tool-use-9' }])
    expect(abortFired).toBe(true)
    // The callback's settlement is written back onto the wire against the same id.
    const settled = scenario
      .readReport()
      .controlResponses.find((frame) => frame.response.request_id === 'perm-421')
    expect(settled?.response.response?.behavior).toBe('deny')
    // Exactly one process spawn per query, control traffic included.
    expect(spawns).toHaveLength(1)
  })

  it('runs the executable given via pathToClaudeCodeExecutable under the default spawner', async () => {
    const scenario = scriptScenario([{ awaitUserMessage: true }, { emit: RESULT_FRAME }])
    const messages = await drainQuery({
      pathToClaudeCodeExecutable: FAKE_CLI,
      cwd: scenario.cwd,
      env: scenarioEnv(scenario)
    })

    expect(messages.some((m) => m.type === 'result')).toBe(true)
    const report = scenario.readReport()
    // The SDK executed exactly the script we pointed it at — no bundled binary.
    expect(report.argv[0]).toBe(FAKE_CLI)
    expect(report.execPath).toContain('node')
    // And the streaming handshake went to it: the SDK sent its initialize
    // control request to our script.
    expect(report.controlRequests.some((frame) => frame.request.subtype === 'initialize')).toBe(
      true
    )
  })

  it('pins the SDK version the contract was verified against', () => {
    const sdkEntry = createRequire(__filename).resolve('@anthropic-ai/claude-agent-sdk')
    const manifest = JSON.parse(readFileSync(join(dirname(sdkEntry), 'package.json'), 'utf8')) as {
      version: string
    }
    expect(manifest.version).toBe(PINNED_SDK_VERSION)
  })

  it('keeps the eight bundled CLI platform binaries out of the install', () => {
    const sdkEntry = createRequire(__filename).resolve('@anthropic-ai/claude-agent-sdk')
    // The SDK's own scoped directory is where pnpm would link its optional
    // platform packages; ignoredOptionalDependencies must keep them all absent.
    const scopeDir = dirname(dirname(sdkEntry))
    for (const basename of SDK_PLATFORM_PACKAGE_BASENAMES) {
      expect(
        existsSync(join(scopeDir, basename, 'package.json')),
        `${basename} must not be installed`
      ).toBe(false)
    }
  })
})

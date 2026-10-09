import { query, type CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it, vi } from 'vitest'
import { claudeQuerySettingsReader } from './claude-agent-sdk-control-requests'
import {
  FAKE_CLI,
  SESSION_ID,
  LEAF_UUID,
  PRE_SDK_ARGV,
  RESULT_FRAME,
  type SpawnSeen,
  scriptScenario,
  scenarioEnv,
  recordingSpawner,
  resolvedLaunch,
  singleUserTurn,
  drainQuery,
  normalizeArgv,
  flagTable
} from './claude-agent-sdk-contract.test-fixture'
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
    // Driven by the real resolver, so the argv walk covers its option set and merge order,
    // not a hand-written options literal.
    const launch = await resolvedLaunch('bypassPermissions', [
      '--model',
      'claude-sonnet-4-5',
      '--dangerously-skip-permissions',
      '--output-format',
      'text',
      '--session-id=wrong-session',
      '--add-dir',
      '/repo/one',
      '/repo/two',
      '--add-dir=/repo/three'
    ])
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
    // The SDK's typed bypass option emits a newer allow flag that older user-installed Claude
    // binaries reject. Keep the older owned flag until Orca establishes a minimum CLI version.
    expect(argv.filter((arg) => arg === '--dangerously-skip-permissions')).toHaveLength(1)
    expect(argv).not.toContain('--allow-dangerously-skip-permissions')
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('default')
    expect(argv[argv.indexOf('--model') + 1]).toBe('claude-sonnet-4-5')
    expect(argv.flatMap((arg, index) => (arg === '--add-dir' ? [argv[index + 1]] : []))).toEqual([
      '/repo/one',
      '/repo/two',
      '/repo/three'
    ])
    expect(argv.filter((arg) => arg === '--model')).toHaveLength(1)
    expect(argv.filter((arg) => arg === '--output-format')).toHaveLength(1)
    expect(argv[argv.indexOf('--output-format') + 1]).toBe('stream-json')
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
})

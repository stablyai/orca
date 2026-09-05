import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnProcess, type SpawnedProcess } from '../../shared/child-process/run-process'
import { hasLiveClaudePtys } from '../claude-accounts/live-pty-gate'
import type { ProcessSpec } from '../../shared/child-process/process-spec'
import { query, type CanUseTool, type Options } from '@anthropic-ai/claude-agent-sdk'
import {
  openClaudeStreamJsonConnection,
  type ClaudeStreamJsonConnection,
  type ClaudeStreamJsonLaunch
} from './claude-stream-json-connection'
import { openAgentSessionJournal } from '../native-chat/agent-session-journal/journal-store-factory'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { claudeAuthDiagnostic } from './claude-structured-init-proof'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import { readClaudeStructuredSessionOptions } from './claude-structured-session-options'
import type { ClaudeSession } from './claude-structured-session-state'
import { CLAUDE_STRUCTURED_BASE_OPTIONS } from './claude-structured-launch-resolution'

// These drive the real SDK against the scripted fake CLI, so every assertion is
// about the environment, argv and frames a real child actually saw.
const FAKE_CLI = join(__dirname, '__fixtures__', 'claude-agent-sdk-scripted-cli.mjs')
const SESSION_ID = '5348c19f-6a54-4c2e-9c68-9c2b1a3d4e5f'
const HOLD_OPEN = { delayMs: 10_000 }

type ScriptedCliReport = {
  argv: string[]
  controlRequests: { request_id: string; request: { subtype: string } }[]
  controlResponses: { response: { request_id: string; response?: unknown } }[]
  userMessages: Record<string, unknown>[]
  descendantPid: number | null
}

const scratchDirs: string[] = []
const openConnections: ClaudeStreamJsonConnection[] = []

afterEach(async () => {
  for (const connection of openConnections.splice(0)) {
    await connection.close()
  }
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  spawned.splice(0)
  spawnedChildren.splice(0)
  vi.unstubAllEnvs()
})

function scriptScenario(
  steps: Record<string, unknown>[],
  controlResponses: Record<string, unknown> = {}
) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-sdk-connection-'))
  scratchDirs.push(dir)
  const scenarioPath = join(dir, 'scenario.json')
  const reportPath = join(dir, 'report.json')
  writeFileSync(scenarioPath, JSON.stringify({ steps, controlResponses }))
  return {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? '',
      ORCA_SDK_CONTRACT_SCENARIO_PATH: scenarioPath,
      ORCA_SDK_CONTRACT_REPORT_PATH: reportPath
    },
    readReport: () => JSON.parse(readFileSync(reportPath, 'utf8')) as ScriptedCliReport
  }
}

function launchFor(
  scenario: { cwd: string; env: Record<string, string> },
  env: Record<string, string> = {}
): ClaudeStreamJsonLaunch {
  return {
    pathToClaudeCodeExecutable: FAKE_CLI,
    options: { ...CLAUDE_STRUCTURED_BASE_OPTIONS, sessionId: SESSION_ID },
    cwd: scenario.cwd,
    env: { ...scenario.env, ...env }
  }
}

/** The derived child environment, captured where Orca actually hands it to the OS. */
const spawned: ProcessSpec[] = []
/** The retained child, so a test can end it the way a crashing CLI would. */
const spawnedChildren: SpawnedProcess[] = []

async function open(
  launch: ClaudeStreamJsonLaunch,
  handlers: Parameters<typeof openClaudeStreamJsonConnection>[1] = {},
  queryImpl?: typeof query
): Promise<ClaudeStreamJsonConnection> {
  const connection = await openClaudeStreamJsonConnection(
    launch,
    handlers,
    (spec) => {
      spawned.push(spec)
      const child = spawnProcess(spec)
      spawnedChildren.push(child)
      return child
    },
    queryImpl
  )
  openConnections.push(connection)
  return connection
}

function childEnv(): Record<string, string | undefined> {
  return (spawned.at(-1)?.env ?? {}) as Record<string, string | undefined>
}

async function until<T>(read: () => T | null | undefined, label: string): Promise<T> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = read()
    if (value !== null && value !== undefined) {
      return value
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function readReportSafely(scenario: { readReport: () => ScriptedCliReport }) {
  try {
    return scenario.readReport()
  } catch {
    return null
  }
}

function processState(pid: number): 'running' | 'exited' {
  try {
    const state = execFileSync('ps', ['-o', 'state=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { ...process.env, LANG: 'C', LC_ALL: 'C' }
    }).trim()
    return state.startsWith('Z') ? 'exited' : 'running'
  } catch (error) {
    if ((error as { status?: number }).status === 1) {
      return 'exited'
    }
    throw error
  }
}

describe('Claude stream-json connection', () => {
  it('passes the Claude Code system-prompt preset through to SDK query', async () => {
    const scenario = scriptScenario([HOLD_OPEN])
    let captured: Options | undefined
    await open(launchFor(scenario), {}, (params) => {
      captured = params.options
      return query(params)
    })

    expect(captured?.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' })
  })

  it('hands the child a derived environment, the resolved CLI path, and keeps the pid', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-SHELL-LEAK')
    vi.stubEnv('CLAUDE_CODE_CHILD_SESSION', '1')
    vi.stubEnv('NODE_OPTIONS', '--require=/tmp/inject.js')
    // An inherited value wins over the SDK's default, so clear it to pin the default.
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', undefined)
    vi.stubEnv('ORCA_CONNECTION_MARKER', 'inherited')
    const scenario = scriptScenario([HOLD_OPEN])
    const connection = await open(
      launchFor(scenario, {
        CLAUDE_CONFIG_DIR: '/accounts/managed/home',
        ANTHROPIC_AUTH_TOKEN: 'configured-token',
        ORCA_AGENT_SESSION_SPAWN_TOKEN: 'spawn-9',
        CLAUDE_CODE_CHILD_SESSION: 'configured-child-session',
        CLAUDE_CODE_SESSION_ID: 'configured-session',
        CLAUDE_CODE_BRIDGE_SESSION_ID: 'configured-bridge-session'
      })
    )

    // Ownership proof: the pid is a real live process, not a value the SDK reported.
    expect(connection.pid).toEqual(expect.any(Number))
    expect(() => process.kill(connection.pid as number, 0)).not.toThrow()
    const env = childEnv()
    // The managed home is pinned verbatim: the CLI keys credential lookup on the literal string.
    expect(env.CLAUDE_CONFIG_DIR).toBe('/accounts/managed/home')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('configured-token')
    expect(env.ORCA_AGENT_SESSION_SPAWN_TOKEN).toBe('spawn-9')
    expect(env.ORCA_CONNECTION_MARKER).toBe('inherited')
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined()
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined()
    expect(env.CLAUDE_CODE_BRIDGE_SESSION_ID).toBeUndefined()
    // Two SDK mutations of the child env, pinned so a bump cannot change them unseen.
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBe('sdk-ts')
    expect(env.NODE_OPTIONS).toBeUndefined()
    // The bundled binary is excluded from the install, so the resolved path is mandatory.
    const report = await until(() => readReportSafely(scenario), 'the scripted CLI report')
    expect(report.argv[0]).toBe(FAKE_CLI)
    // The .mjs fixture makes the SDK run it under node; a real CLI path is the program
    // itself. Either way the resolved path is what Orca's spawner is asked to execute.
    expect([spawned.at(-1)?.program, ...(spawned.at(-1)?.args ?? [])]).toContain(FAKE_CLI)
    expect(report.argv).toContain('--replay-user-messages')
    expect(report.argv).toContain(`--session-id=${SESSION_ID}`)
  })

  it('leaves the default CLI home unpinned so macOS Keychain OAuth keeps working', async () => {
    const scenario = scriptScenario([HOLD_OPEN])
    await open(launchFor(scenario))

    await until(() => readReportSafely(scenario), 'the scripted CLI report')
    expect(childEnv().CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  it('settles a send only once the frame reached the child, and replays reach onMessage', async () => {
    const replay = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      parent_tool_use_id: null,
      isReplay: true,
      session_id: SESSION_ID,
      uuid: 'uuid-replay-1'
    }
    const scenario = scriptScenario([{ awaitUserMessage: true }, { emit: replay }, HOLD_OPEN])
    const messages: Record<string, unknown>[] = []
    const connection = await open(launchFor(scenario), {
      onMessage: (message) => messages.push(message)
    })

    await connection.send({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      parent_tool_use_id: null,
      session_id: SESSION_ID
    })
    // The report exists from the child's first line of work, so poll for the frame
    // itself: `send` settles on the SDK's completed write, and the child still has
    // to read that line before it can record it.
    const report = await until(
      () => (readReportSafely(scenario)?.userMessages.length ? readReportSafely(scenario) : null),
      'the user frame recorded by the child'
    )
    expect(report.userMessages).toHaveLength(1)

    await until(() => messages.find((message) => message.uuid === 'uuid-replay-1'), 'the replay')
    // The replay is delivered verbatim, so the dispatch acknowledgement still binds on it.
    expect(messages.find((message) => message.uuid === 'uuid-replay-1')).toEqual(replay)
  })

  it('rejects a send the SDK pulled but could not write to a terminated child', async () => {
    const scenario = scriptScenario([{ awaitUserMessage: true }, HOLD_OPEN])
    const connection = await open(launchFor(scenario))
    const child = spawnedChildren.at(-1)

    // Same tick as the send, so the liveness guard still passes and the frame
    // reaches the SDK's input pump: its `transport.write` is what fails, which is
    // the window a child crashing mid-send actually opens.
    child?.kill('SIGKILL')
    const sent = connection.send({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      parent_tool_use_id: null,
      session_id: SESSION_ID
    })

    await expect(sent).rejects.toThrow()
    expect(readReportSafely(scenario)?.userMessages ?? []).toHaveLength(0)
  })

  it('delivers an unmodeled frame verbatim so the provider-fallback row survives', async () => {
    const unknown = {
      type: 'frame_kind_from_the_future',
      session_id: SESSION_ID,
      uuid: 'uuid-unknown-1',
      payload: { nested: { flags: ['a', 'b'] } }
    }
    const scenario = scriptScenario([{ emit: unknown }, HOLD_OPEN])
    const messages: Record<string, unknown>[] = []
    await open(launchFor(scenario), { onMessage: (message) => messages.push(message) })

    await until(() => messages.find((message) => message.uuid === 'uuid-unknown-1'), 'the frame')
    expect(messages.find((message) => message.uuid === 'uuid-unknown-1')).toEqual(unknown)
  })

  it('commits the real partial-message cadence as one assistant item through the translator', async () => {
    // The frame order and per-frame uuids are the ones Claude Code 2.1.258 emits
    // under --include-partial-messages: every stream_event and the block's final
    // assistant frame each carry their own uuid; only message.id ties them.
    const stream = (uuid: string, event: Record<string, unknown>) => ({
      type: 'stream_event',
      uuid,
      session_id: SESSION_ID,
      parent_tool_use_id: null,
      event
    })
    const frames = [
      stream('uuid-message-start', {
        type: 'message_start',
        message: { id: 'msg_01', role: 'assistant', content: [] }
      }),
      stream('uuid-block-start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      }),
      stream('uuid-delta-1', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'ST' }
      }),
      stream('uuid-delta-2', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'REAMOK_ELEC_64E632' }
      }),
      {
        type: 'assistant',
        uuid: 'uuid-assistant-final',
        session_id: SESSION_ID,
        parent_tool_use_id: null,
        message: {
          id: 'msg_01',
          role: 'assistant',
          content: [{ type: 'text', text: 'STREAMOK_ELEC_64E632' }],
          stop_reason: null
        }
      },
      stream('uuid-block-stop', { type: 'content_block_stop', index: 0 }),
      stream('uuid-message-delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      stream('uuid-message-stop', { type: 'message_stop' }),
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        result: 'STREAMOK_ELEC_64E632',
        stop_reason: 'end_turn',
        session_id: SESSION_ID,
        uuid: 'uuid-result'
      }
    ]
    const scenario = scriptScenario([...frames.map((frame) => ({ emit: frame })), HOLD_OPEN])
    const journal = await openAgentSessionJournal({
      identity: {
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        hostId: 'host-1',
        agent: 'claude',
        providerHandle: { kind: 'claude', sessionId: SESSION_ID, leafUuid: 'leaf-1' }
      },
      journalDir: join(scenario.cwd, 'journal'),
      now: () => 1_700_000_000_000,
      mintEpoch: () => 'epoch-1'
    })
    const deferred = createDeferredStructuredAgentSessionEventSink()
    deferred.bind({ journal, fence: 1, publish: vi.fn() })
    const translator = createClaudeJournalTranslator({ sink: deferred.sink })
    let settled = false
    await open(launchFor(scenario), {
      onMessage: (message) => {
        translator.handle({ type: 'message', sessionId: 'session-1', message })
        settled ||= message.type === 'result'
      }
    })

    await until(() => (settled ? true : null), 'the result frame')
    await deferred.drained()
    const items = journal.snapshot().items
    const assistant = items.filter(
      (item) => item.body.kind === 'message' && item.body.role === 'assistant'
    )
    expect(assistant.map((item) => item.body)).toEqual([
      {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'STREAMOK_ELEC_64E632' }]
      }
    ])
    expect(assistant.map((item) => item.itemId)).toEqual([`claude:${SESSION_ID}:uuid-block-start`])
    expect(
      items.flatMap((item) =>
        item.body.kind === 'status' && item.body.providerFrame ? [item.body.providerFrame.kind] : []
      )
    ).toEqual([])
    // The journal owns a SQLite connection now; afterEach removes this temp root and an open
    // handle blocks that on Windows.
    await journal.close()
  })

  it('feeds an inbound permission request to canUseTool and writes its answer back on the same id', async () => {
    const scenario = scriptScenario([
      {
        emit: {
          type: 'control_request',
          request_id: 'perm-421',
          request: {
            subtype: 'can_use_tool',
            tool_name: 'Bash',
            input: { command: 'ls' },
            tool_use_id: 'toolu_1',
            permission_suggestions: [{ type: 'addRules' }]
          }
        }
      },
      { awaitControlResponse: 'perm-421' },
      HOLD_OPEN
    ])
    const seen: { toolName: string; requestId: string; toolUseID: string; suggestions: unknown }[] =
      []
    const canUseTool: CanUseTool = (toolName, _input, options) => {
      seen.push({
        toolName,
        requestId: options.requestId,
        toolUseID: options.toolUseID,
        suggestions: options.suggestions
      })
      return Promise.resolve({ behavior: 'deny', message: 'No', toolUseID: options.toolUseID })
    }
    await open(launchFor(scenario), { canUseTool })

    await until(() => (seen.length > 0 ? seen : null), 'the inbound permission request')
    expect(seen).toEqual([
      {
        toolName: 'Bash',
        requestId: 'perm-421',
        toolUseID: 'toolu_1',
        suggestions: [{ type: 'addRules' }]
      }
    ])
    const written = await until(
      () =>
        readReportSafely(scenario)?.controlResponses.find(
          (frame) => frame.response.request_id === 'perm-421'
        ),
      'the permission answer'
    )
    expect(written.response.response).toMatchObject({ behavior: 'deny', message: 'No' })
  })

  it('drives Orca control methods onto the SDK and times out with the init proof message', async () => {
    const scenario = scriptScenario([HOLD_OPEN], {
      initialize: { models: [{ value: 'sonnet' }], account: { tokenSource: 'oauth' } },
      get_settings: { env: { ANTHROPIC_BASE_URL: 'https://settings.example.test' } }
    })
    const connection = await open(launchFor(scenario))

    await expect(connection.initializationResult()).resolves.toMatchObject({
      models: [{ value: 'sonnet' }]
    })
    await expect(connection.getSettings()).resolves.toEqual({
      env: { ANTHROPIC_BASE_URL: 'https://settings.example.test' }
    })
    await expect(connection.setModel('opus')).resolves.toBeUndefined()
    const requests = await until(
      () =>
        readReportSafely(scenario)?.controlRequests.find(
          (frame) => frame.request.subtype === 'set_model'
        ),
      'the set_model control request'
    )
    expect(requests.request.subtype).toBe('set_model')
  })

  it('reads supportedModels from the catalog the running CLI reported', async () => {
    const scenario = scriptScenario([HOLD_OPEN], {
      initialize: {
        models: [
          { value: 'default', resolvedModel: 'claude-opus-5' },
          {
            value: 'opus',
            displayName: 'Opus 5',
            description: 'The live row, not the seed',
            resolvedModel: 'claude-opus-5',
            supportsEffort: true,
            supportedEffortLevels: ['low', 'high']
          }
        ]
      }
    })
    const connection = await open(launchFor(scenario))

    await expect(connection.supportedModels()).resolves.toMatchObject([
      { value: 'default', resolvedModel: 'claude-opus-5' },
      { value: 'opus', displayName: 'Opus 5', supportedEffortLevels: ['low', 'high'] }
    ])
  })

  it('serves the picker the live catalog rather than falling back to the static seed', async () => {
    const scenario = scriptScenario([HOLD_OPEN], {
      initialize: {
        models: [
          { value: 'default', resolvedModel: 'claude-opus-5' },
          {
            value: 'opus',
            displayName: 'Opus 5',
            description: 'The live row, not the seed',
            resolvedModel: 'claude-opus-5',
            supportsEffort: true,
            supportedEffortLevels: ['low', 'high']
          }
        ]
      }
    })
    const connection = await open(launchFor(scenario))
    const session = {
      connection,
      options: new Map<string, string>(),
      reportedOptions: {}
    } as unknown as ClaudeSession

    const options = await readClaudeStructuredSessionOptions(session, 5_000)

    // The seed carries neither this description nor a two-level effort list, so
    // both can only have come from the child.
    expect(options.models).toContainEqual({
      id: 'opus',
      label: 'Opus 5',
      description: 'The live row, not the seed',
      isDefault: true,
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'high', label: 'High' }
      ]
    })
    expect(options.current.model).toBe('opus')
  })

  it('feeds the auth diagnostic from the settings the running child reports', async () => {
    for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
      vi.stubEnv(key, undefined)
    }
    const scenario = scriptScenario([HOLD_OPEN], {
      get_settings: {
        env: {
          ANTHROPIC_BASE_URL: 'https://settings.example.test',
          ANTHROPIC_AUTH_TOKEN: 'secret'
        }
      }
    })
    const connection = await open(launchFor(scenario))
    const init = { providerSessionId: SESSION_ID, uuid: null, model: null, message: {} }

    // With no ambient auth, every true below can only have come from the CLI's settings.
    expect(claudeAuthDiagnostic(init, null)).toMatchObject({
      baseUrlConfigured: false,
      authTokenConfigured: false
    })
    const diagnostic = claudeAuthDiagnostic(init, await connection.getSettings())
    expect(diagnostic).toMatchObject({
      baseUrlConfigured: true,
      authTokenConfigured: true,
      apiKeyConfigured: false
    })
    expect(JSON.stringify(diagnostic)).not.toContain('secret')
  })

  it('reports an unauthenticated start through the init deadline instead of hanging', async () => {
    // The scripted CLI never answers, which is the shape of a silently unauthenticated CLI.
    const scenario = scriptScenario([HOLD_OPEN])
    const connection = await open({
      ...launchFor(scenario),
      env: { ...launchFor(scenario).env, ORCA_SDK_CONTRACT_IGNORE_CONTROL_REQUESTS: '1' }
    })

    await expect(connection.initializationResult({ timeoutMs: 200 })).rejects.toThrow(
      'claude initialize request timed out'
    )
  })

  it('reports a self-exit with its status and stderr, and leaves its tree unverifiable', async () => {
    const scenario = scriptScenario([{ stderr: 'claude: not signed in\n' }, { exit: 1 }])
    let exit: Error | null = null
    const connection = await open(launchFor(scenario), {
      onExit: (error) => {
        exit = error
      }
    })

    await until(() => exit, 'the exit error')
    // The status and stderr are the only diagnostic a refused start leaves behind.
    expect((exit as unknown as Error).message).toMatch(/exited \(code 1\): claude: not signed in/)
    expect(connection.closed).toBe(true)
    // The root's exit is first-hand, but it left before a descendant snapshot
    // could be armed, so close() has no tree proof to offer and says so.
    await expect(connection.close()).resolves.toBe(false)
    expect(connection.exitVerdict).toEqual({ root: 'exited', tree: 'unverifiable' })
  })

  it.runIf(process.platform !== 'win32')(
    'proves a natural SDK exit and cleans up its descendant before recovery',
    async () => {
      const scenario = scriptScenario([
        { stderr: 'claude: natural exit\n' },
        { delayMs: 500 },
        { exit: 1 }
      ])
      let exit: Error | null = null
      const connection = await open(
        {
          ...launchFor(scenario),
          env: { ...launchFor(scenario).env, ORCA_SDK_CONTRACT_DESCENDANT: '1' }
        },
        { onExit: (error) => (exit = error) }
      )
      const report = await until(() => {
        const current = readReportSafely(scenario)
        return current?.descendantPid ? current : null
      }, 'the descendant report')
      await until(() => exit, 'the natural exit error')
      try {
        await expect(connection.close()).resolves.toBe(true)
        expect(connection.exitVerdict).toEqual({ root: 'exited', tree: 'exited' })
        expect(processState(report.descendantPid as number)).toBe('exited')
      } finally {
        try {
          process.kill(report.descendantPid as number, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }
    },
    20_000
  )

  it('settles a spawn error followed by close as processless and closes idempotently', async () => {
    const scenario = scriptScenario([HOLD_OPEN])
    const missingCli = join(scenario.cwd, 'claude-that-does-not-exist')
    let fault: Error | null = null
    let exit: Error | null = null
    const connection = await open(
      { ...launchFor(scenario), pathToClaudeCodeExecutable: missingCli },
      {
        onFault: (error) => {
          fault = error
        },
        onExit: (error) => {
          exit = error
        }
      }
    )

    await until(
      () => (connection.exitVerdict.root === 'processless' ? connection.exitVerdict : null),
      'the processless spawn settlement'
    )
    expect(connection.pid).toBeUndefined()
    expect(fault).toBeInstanceOf(Error)
    expect(exit).toBeNull()
    await expect(Promise.all([connection.close(), connection.close()])).resolves.toEqual([
      true,
      true
    ])
    await expect(connection.close()).resolves.toBe(true)
    expect(connection.exitVerdict).toEqual({ root: 'processless', tree: 'exited' })
  })

  it('does not treat a child error event as first-hand root exit proof', async () => {
    const scenario = scriptScenario([HOLD_OPEN])
    let exit: Error | null = null
    const connection = await open(launchFor(scenario), {
      onExit: (error) => {
        exit = error
      }
    })
    const child = spawnedChildren.at(-1)
    expect(child).toBeDefined()

    child?.emit('error', new Error('child transport fault'))

    expect(exit).toBeNull()
    expect(connection.exitVerdict.root).toBe('live')
    await until(() => exit, 'the distinct child exit')
    expect(connection.exitVerdict.root).toBe('exited')
  })

  it('proves the exit of a child that ignores a graceful shutdown', async () => {
    const scenario = scriptScenario([HOLD_OPEN])
    const connection = await open({
      ...launchFor(scenario),
      env: { ...launchFor(scenario).env, ORCA_SDK_CONTRACT_IGNORE_SIGTERM: '1' }
    })

    // Keep the lstart capture boundary outside the child's displayed start second.
    await new Promise((resolve) => setTimeout(resolve, 1_100))
    await expect(connection.close()).resolves.toBe(true)
  }, 20_000)
})

// A structured Claude child owns the account's credentials while it runs, exactly as
// a Claude PTY does. The gate is what makes runtime-auth-sync defer the managed OAuth
// refresh instead of rotating the single-use token out from under a live session, and
// structured sessions used to be invisible to it.
describe('the managed-auth live gate', () => {
  it('holds while a structured child runs and releases when it ends', async () => {
    // The gate is a process-wide singleton and a sibling test's release lands on its
    // child's 'close' event, which can settle after that test's close() resolved.
    await until(() => (hasLiveClaudePtys() ? null : true), 'a drained auth gate')
    const scenario = scriptScenario([
      { emit: { type: 'system', subtype: 'init', session_id: SESSION_ID, uuid: 'init-1' } },
      { wait: HOLD_OPEN }
    ])
    const connection = await open(launchFor(scenario))

    expect(hasLiveClaudePtys()).toBe(true)

    await connection.close()

    await until(() => (hasLiveClaudePtys() ? null : true), 'the auth gate to drain')
    expect(hasLiveClaudePtys()).toBe(false)
  }, 30_000)

  it('releases when the child dies on its own rather than through close()', async () => {
    await until(() => (hasLiveClaudePtys() ? null : true), 'a drained auth gate')
    const scenario = scriptScenario([
      { emit: { type: 'system', subtype: 'init', session_id: SESSION_ID, uuid: 'init-1' } },
      { wait: HOLD_OPEN }
    ])
    await open(launchFor(scenario))
    expect(hasLiveClaudePtys()).toBe(true)

    spawnedChildren.at(-1)?.kill('SIGKILL')

    await until(() => (hasLiveClaudePtys() ? null : true), 'the auth gate to drain')
    expect(hasLiveClaudePtys()).toBe(false)
  }, 30_000)

  // The gate entry is deliberately unpersisted, so confirmSeededClaudeLivePtys can never
  // reconcile a stray one: a leak here defers the managed OAuth refresh for the life of
  // the process. Entering the gate only after the release handlers are attached makes
  // that unreachable regardless of what the setup in between does.
  it('leaks no gate entry when setup throws between spawn and handler attachment', async () => {
    await until(() => (hasLiveClaudePtys() ? null : true), 'a drained auth gate')
    const scenario = scriptScenario([
      { emit: { type: 'system', subtype: 'init', session_id: SESSION_ID, uuid: 'init-1' } },
      { wait: HOLD_OPEN }
    ])
    let started: SpawnedProcess | null = null

    try {
      await expect(
        openClaudeStreamJsonConnection(launchFor(scenario), {}, (spec) => {
          const child = spawnProcess(spec)
          started = child
          const attach = child.stderr.on.bind(child.stderr)
          // Measured attach order: the SDK binds stderr 'data' from inside query(),
          // before the child is even assigned. The SECOND bind is this connection's own
          // armTreeOnOutput — the first statement that runs after the child exists and
          // before its 'exit'/'close' release handlers. Throwing on the first is
          // vacuous: it escapes before any gate entry could have happened.
          let dataAttaches = 0
          child.stderr.on = ((event: string, listener: (...args: unknown[]) => void) => {
            if (event === 'data') {
              dataAttaches += 1
              if (dataAttaches === 2) {
                throw new Error('stderr listener attach failed')
              }
            }
            return attach(event, listener)
          }) as typeof child.stderr.on
          return child
        })
      ).rejects.toThrow('stderr listener attach failed')

      expect(hasLiveClaudePtys()).toBe(false)
    } finally {
      ;(started as SpawnedProcess | null)?.kill('SIGKILL')
    }
  }, 30_000)
})

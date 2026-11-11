import { createClaudeCodeProcessSpawn } from './claude-agent-sdk-process-spawn'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  query,
  type CanUseTool,
  type Options,
  type SDKUserMessage,
  type SpawnedProcess as SdkSpawnedProcess,
  type SpawnOptions as SdkSpawnOptions
} from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import { ClaudePromptRegistry } from './claude-prompt-registry'
import { claudeLaunchPermissions } from './structured/claude-structured-inbound-control'
import { claudeStructuredPermissionOptions } from './structured/launch/claude-structured-launch-resolution'

// Exercise the real SDK against a scripted CLI to detect protocol and spawn-contract drift.

const FAKE_CLI = join(__dirname, '__fixtures__', 'claude-agent-sdk-scripted-cli.mjs')
const SESSION_ID = '5348c19f-6a54-4c2e-9c68-9c2b1a3d4e5f'

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
  controlResponses: Record<string, unknown> = {},
  extra: Record<string, unknown> = {}
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
  writeFileSync(scenarioPath, JSON.stringify({ steps, controlResponses, ...extra }))
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

function singleUserTurn(): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    yield {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      parent_tool_use_id: null,
      session_id: SESSION_ID
    } as SDKUserMessage
    // Keep input open until the scripted CLI exits; an unresolved promise does not keep Node alive.
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

describe('Claude Agent SDK contract pins', () => {
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
    const settled = scenario
      .readReport()
      .controlResponses.find((frame) => frame.response.request_id === 'perm-421')
    expect(settled?.response.response?.behavior).toBe('deny')
    expect(spawns).toHaveLength(1)
  })

  describe("Full access decisions keep each request's place in one stdout chunk", () => {
    const status = (permissionMode: string) => ({
      type: 'system',
      subtype: 'status',
      status: null,
      permissionMode,
      session_id: SESSION_ID
    })
    const ask = (id: string, extra: Record<string, unknown> = {}) => ({
      type: 'control_request',
      request_id: id,
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        input: { command: 'echo harmless' },
        tool_use_id: `tool-${id}`,
        ...extra
      }
    })
    const cancel = (id: string) => ({ type: 'control_cancel_request', request_id: id })
    type WireFrame = ReturnType<typeof status> | ReturnType<typeof ask> | ReturnType<typeof cancel>
    const isAsk = (frame: WireFrame): frame is ReturnType<typeof ask> => 'request' in frame
    const many = (prefix: string) =>
      Array.from({ length: 300 }, (_, index) => ask(`${prefix}${index}`))
    const asked = (ids: string[], allowed: boolean) =>
      ids.map((requestId) => ({ requestId, allowed }))
    const manyIds = (prefix: string) => many(prefix).map((frame) => frame.request_id)

    it.each([
      {
        label: 'plan, then bypass, with the interaction flag',
        frames: [
          status('plan'),
          ask('A'),
          status('bypassPermissions'),
          ask('B'),
          ask('flagged', { tool_name: 'mcp__forms__confirm', requires_user_interaction: true })
        ],
        seen: [...asked(['A'], false), ...asked(['B'], true), ...asked(['flagged'], false)],
        interaction: [true],
        pending: []
      },
      {
        label: 'a request initialize resends, then plan',
        frames: [status('plan'), ask('A')],
        seen: [...asked(['resent'], true), ...asked(['A'], false)],
        interaction: [],
        pending: [ask('resent')]
      },
      {
        label: 'a cancel in the same chunk',
        frames: [status('plan'), ask('A'), cancel('A'), status('bypassPermissions'), ask('B')],
        seen: [...asked(['A'], false), ...asked(['B'], true)],
        interaction: [],
        pending: []
      },
      {
        label: 'a duplicate id after bypass',
        frames: [status('plan'), ask('A'), status('bypassPermissions'), ask('A'), ask('B')],
        seen: [...asked(['A', 'A'], false), ...asked(['B'], true)],
        interaction: [],
        pending: []
      },
      {
        label: 'more than 256 unread requests in plan',
        frames: [status('plan'), ...many('p'), status('bypassPermissions'), ask('B')],
        seen: [...asked(manyIds('p'), false), ...asked(['B'], true)],
        interaction: [],
        pending: []
      },
      {
        label: 'more than 256 unread requests in Full access',
        frames: [status('bypassPermissions'), ...many('f'), status('plan'), ask('C')],
        seen: [...asked(manyIds('f'), true), ...asked(['C'], false)],
        interaction: [],
        pending: []
      }
    ])('$label', async ({ frames, seen: expected, interaction: flags, pending }) => {
      const requestIds = [
        ...new Set([...pending, ...frames].filter(isAsk).map((frame) => frame.request_id))
      ]
      const scenario = scriptScenario(
        [
          { awaitUserMessage: true },
          { emitTogether: frames },
          ...requestIds.map((id) => ({ awaitControlResponse: id })),
          { emit: RESULT_FRAME }
        ],
        {},
        { pendingPermissionRequests: { initialize: pending } }
      )
      const prompts = new ClaudePromptRegistry()
      const permissions = claudeLaunchPermissions(
        { sessionId: 'session-1', prompts, emit: () => {} },
        {
          providerSessionId: SESSION_ID,
          options: claudeStructuredPermissionOptions('full-access')
        }
      )
      const seen: { requestId: string; allowed: boolean }[] = []
      const interaction: unknown[] = []
      const canUseTool: CanUseTool = async (toolName, input, options) => {
        if ('requiresUserInteraction' in options) {
          interaction.push(options.requiresUserInteraction)
        }
        const answer = permissions.handlers.canUseTool!(toolName, input, options)
        // Answer any card at once so the scripted turn can finish.
        prompts.find(options.requestId)?.prompt.settle({
          behavior: 'deny',
          message: 'asked',
          toolUseID: options.toolUseID
        })
        const decision = { requestId: options.requestId, allowed: false }
        seen.push(decision)
        const result = await answer
        decision.allowed = result?.behavior === 'allow'
        return result ?? { behavior: 'deny', message: 'cancelled', toolUseID: options.toolUseID }
      }
      const spawner = createClaudeCodeProcessSpawn(
        spawnProcess,
        process.platform,
        { pathToClaudeCodeExecutable: FAKE_CLI },
        permissions.handlers.onStdout
      )
      await drainQuery({
        pathToClaudeCodeExecutable: FAKE_CLI,
        cwd: scenario.cwd,
        env: scenarioEnv(scenario),
        canUseTool,
        spawnClaudeCodeProcess: spawner.spawn
      })

      expect(seen).toEqual(expected)
      expect(interaction).toEqual(flags)
    })
  })
})

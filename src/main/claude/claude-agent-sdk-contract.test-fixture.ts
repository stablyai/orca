import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  query,
  type Options,
  type PermissionMode,
  type SDKUserMessage,
  type SpawnedProcess as SdkSpawnedProcess,
  type SpawnOptions as SdkSpawnOptions
} from '@anthropic-ai/claude-agent-sdk'
import { afterEach, vi } from 'vitest'
import { spawnProcess } from '../../shared/child-process/run-process'
import { record as savedRecord, IDENTITY } from './claude-structured-launch-resolution.test-fixture'
import { z } from 'zod'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { createClaudeStructuredLaunchResolver } from './claude-structured-launch-resolution'

// Contract pins for @anthropic-ai/claude-agent-sdk, run against the real SDK
// driving a scripted fake CLI (never the real Claude binary). These tests exist
// to catch a future SDK version drifting under Orca: unknown-frame pass-through,
// spawner env fidelity, argument parity with the pre-SDK argv,
// permission-callback semantics, and executable-path override.

export const FAKE_CLI = join(__dirname, '__fixtures__', 'claude-agent-sdk-scripted-cli.mjs')
export const SESSION_ID = '5348c19f-6a54-4c2e-9c68-9c2b1a3d4e5f'
export const LEAF_UUID = 'ad0f7c9e-1b2c-4d3e-8f90-abc123def456'

/**
 * The exact argv the hand-rolled transport built before the SDK swap. Frozen here
 * as the parity oracle: CLAUDE_STRUCTURED_BASE_OPTIONS has to keep producing it.
 */
export const PRE_SDK_ARGV = [
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

export const RESULT_FRAME = {
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
export type SpawnSeen = {
  command: string
  args: string[]
  cwd: string | undefined
  env: Record<string, string | undefined>
}
const scriptedCliReport = z.object({
  argv: z.array(z.string()),
  execPath: z.string(),
  controlRequests: z.array(
    z.object({ request_id: z.string(), request: z.object({ subtype: z.string() }) })
  ),
  controlResponses: z.array(
    z.object({
      response: z.object({
        request_id: z.string(),
        response: z.record(z.string(), z.unknown()).optional()
      })
    })
  ),
  userMessages: z.array(z.record(z.string(), z.unknown()))
})
type ScriptedCliReport = z.infer<typeof scriptedCliReport>

const scratchDirs: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

export function scriptScenario(
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
    readReport: () => scriptedCliReport.parse(JSON.parse(readFileSync(reportPath, 'utf8')))
  }
}

export function scenarioEnv(scenario: { scenarioPath: string; reportPath: string }) {
  return {
    PATH: process.env.PATH,
    ORCA_SDK_CONTRACT_SCENARIO_PATH: scenario.scenarioPath,
    ORCA_SDK_CONTRACT_REPORT_PATH: scenario.reportPath
  }
}

export function recordingSpawner(spawns: SpawnSeen[]) {
  return (opts: SdkSpawnOptions): SdkSpawnedProcess => {
    spawns.push({
      command: opts.command,
      args: [...opts.args],
      cwd: opts.cwd,
      env: { ...opts.env }
    })
    const child = spawnProcess({
      program: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
      signal: opts.signal
    })
    if (!child.stdin || !child.stdout) {
      throw new Error('Scripted child requires piped input and output')
    }
    return Object.assign(child, { stdin: child.stdin, stdout: child.stdout })
  }
}

export function resolvedLaunch(permissionMode: PermissionMode, launchArgs: string[] = []) {
  const record: ReturnType<typeof savedRecord> = {
    ...savedRecord(),
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
    options: { permissionMode: permissionMode === 'bypassPermissions' ? 'bypass' : 'ask' },
    launchArgs
  }
  return createClaudeStructuredLaunchResolver({
    resolveLaunchArgs: () => launchArgs,
    store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
    resolveWorkspacePath: async () => '/repos/workspace-1',
    resolveCommand: () => FAKE_CLI,
    resolveAuthPolicy: () => ({ stripAuthEnv: true })
  })({ identity: { ...IDENTITY, sessionId: record.sessionId } })
}

export function singleUserTurn(): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      parent_tool_use_id: null,
      session_id: SESSION_ID
    }
    yield message
    // Hold input open; the stream ends when the scripted CLI exits, and an
    // unresolved bare promise does not keep the event loop alive.
    await new Promise<void>(() => {})
  })()
}

export async function drainQuery(options: Options): Promise<Record<string, unknown>[]> {
  const messages: Record<string, unknown>[] = []
  for await (const message of query({ prompt: singleUserTurn(), options })) {
    messages.push(Object.fromEntries(Object.entries(message)))
  }
  return messages
}

/** Expand `--flag=value` argv entries so both SDK spellings compare equal. */
export function normalizeArgv(args: string[]): string[] {
  return args.flatMap((arg) => {
    if (!arg.startsWith('--')) {
      return [arg]
    }
    const eq = arg.indexOf('=')
    return eq === -1 ? [arg] : [arg.slice(0, eq), arg.slice(eq + 1)]
  })
}

/** Group the pre-SDK argv into flag/value pairs. */
export function flagTable(args: readonly string[]): { flag: string; value: string | null }[] {
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

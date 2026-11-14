import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import type { ProcessSpec } from '@orca/process-host/process-spec'

import {
  openClaudeStreamJsonConnection,
  type ClaudeStreamJsonConnection,
  type ClaudeStreamJsonLaunch
} from '../claude-stream-json-connection'
import { claudeLaunchPermissions } from '../structured/claude-structured-inbound-control'
import { ClaudePromptRegistry } from '../structured/permissions/claude-prompt-registry'
import { CLAUDE_STRUCTURED_BASE_OPTIONS } from '../structured/launch/claude-structured-launch-resolution'

// Exercise the real SDK against a scripted child CLI.
const FAKE_CLI = join(__dirname, '../__fixtures__', 'claude-agent-sdk-scripted-cli.mjs')
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
const childClosures: Promise<void>[] = []

afterEach(async () => {
  for (const connection of openConnections.splice(0)) {
    await connection.close()
  }
  await Promise.all(childClosures.splice(0))
  for (const dir of scratchDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
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

const spawned: ProcessSpec[] = []
const spawnedChildren: ChildProcess[] = []

async function open(
  launch: ClaudeStreamJsonLaunch,
  handlers: Parameters<typeof openClaudeStreamJsonConnection>[1] = {}
): Promise<ClaudeStreamJsonConnection> {
  const connection = await openClaudeStreamJsonConnection(launch, handlers, (spec) => {
    spawned.push(spec)
    const child = spawnProcess(spec)
    spawnedChildren.push(child)
    childClosures.push(new Promise<void>((resolve) => child.once('close', () => resolve())))
    return child
  })
  openConnections.push(connection)
  return connection
}

describe('Claude stream-json connection', () => {
  it.each([
    'eof',
    'cancel',
    'cancel-before-eof',
    'cancel-unterminated',
    'oversized-cancel',
    'malformed-eof'
  ] as const)(
    'keeps a saved question on %s unless the exact provider request was withdrawn',
    async (ending) => {
      const question = {
        type: 'control_request',
        request_id: 'question-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'AskUserQuestion',
          tool_use_id: 'tool-1',
          input: {
            questions: [{ question: 'Which branch?', options: [] }],
            ...(ending === 'oversized-cancel' ? { detail: 'x'.repeat(17 * 1024 * 1024) } : {})
          }
        }
      }
      const scenario = scriptScenario([])
      const acknowledged = join(scenario.cwd, 'question-seen')
      writeFileSync(
        scenario.env.ORCA_SDK_CONTRACT_SCENARIO_PATH,
        JSON.stringify({
          steps: [
            { awaitControlRequest: 'initialize' },
            { emit: question },
            { awaitFile: { path: acknowledged, timeoutMs: 10_000 } },
            ...(ending === 'eof'
              ? []
              : ending === 'cancel-unterminated' || ending === 'malformed-eof'
                ? [
                    {
                      stdoutChunks:
                        ending === 'malformed-eof'
                          ? ['{"type":"control_cancel_request","request_id":']
                          : [
                              '{"type":"control_cancel_\\u0072equest","request_id":"question-',
                              '1"}'
                            ]
                    }
                  ]
                : [
                    {
                      emit: {
                        type: 'control_cancel_request',
                        request_id: 'question-1'
                      }
                    }
                  ]),
            ending === 'cancel' ? HOLD_OPEN : { exit: 1 }
          ]
        })
      )
      const prompts = new ClaudePromptRegistry()
      const seen = Promise.withResolvers<void>()
      const settled = Promise.withResolvers<unknown>()
      const events: string[] = []
      const launch = launchFor(scenario)
      const permissions = claudeLaunchPermissions(
        {
          sessionId: SESSION_ID,
          prompts,
          emit: (event) => {
            events.push(event.type)
            if (event.type === 'prompt') {
              seen.resolve()
            }
          }
        },
        { options: launch.options, providerSessionId: SESSION_ID }
      )
      await open(launch, {
        ...permissions.handlers,
        canUseTool: async (...args) => {
          const response = await permissions.handlers.canUseTool!(...args)
          settled.resolve(response)
          return response
        }
      })
      await seen.promise
      writeFileSync(acknowledged, 'seen')
      await expect(settled.promise).resolves.toBeNull()
      expect(events).toEqual(
        ending === 'eof' || ending === 'malformed-eof' ? ['prompt'] : ['prompt', 'prompt-cancelled']
      )
      expect(prompts.find('question-1')).toBeNull()
      expect(scenario.readReport().controlResponses).not.toContainEqual(
        expect.objectContaining({ response: expect.objectContaining({ request_id: 'question-1' }) })
      )
    }
  )

  it('completes task Stop through the real SDK while semantic reading is paused', async () => {
    const scenario = scriptScenario([HOLD_OPEN])
    const connection = await open(launchFor(scenario))
    await connection.initializationResult()
    connection.pauseReading?.()
    await connection.stopTask('owned-shell')
    expect(scenario.readReport().controlRequests).toContainEqual(
      expect.objectContaining({
        request: expect.objectContaining({ subtype: 'stop_task', task_id: 'owned-shell' })
      })
    )
    connection.resumeReading?.()
  })
})

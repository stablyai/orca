import { execFileSync, type ChildProcess } from 'node:child_process'
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
} from './claude-stream-json-connection'
import { CLAUDE_STRUCTURED_BASE_OPTIONS } from './structured/launch/claude-structured-launch-resolution'

// Exercise the real SDK against a scripted child CLI.
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
})

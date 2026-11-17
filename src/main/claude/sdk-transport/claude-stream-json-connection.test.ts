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
import { CLAUDE_STRUCTURED_BASE_OPTIONS } from '../structured/launch/claude-structured-launch-resolution'
import { providerStartupFailureFact } from '../../native-chat/agent-session-wire/startup/structured-agent-session-failure-text'
import * as providerSpawn from '../../provider-process/provider-process-spawn'
import { createFakeSpawnedChild } from '../../../shared/__fixtures__/fake-spawned-child'

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
  vi.restoreAllMocks()
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
  it.each(['cliMissing', 'fullAccessAsRoot'] as const)(
    'keeps %s when an input pipe fails before the child reports its ending',
    async (kind) => {
      const child = createFakeSpawnedChild(9_999_999)
      const scenario = scriptScenario([])
      const launch = launchFor(scenario)
      if (kind === 'cliMissing') {
        Object.defineProperty(child, 'pid', { value: undefined })
        launch.pathToClaudeCodeExecutable = join(scenario.cwd, 'missing-claude')
      }
      vi.spyOn(providerSpawn, 'spawnProviderProcess').mockReturnValue(child)
      const fault = Promise.withResolvers<Error>()
      const connection = await open(launch, { onFault: fault.resolve })
      child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
      if (kind === 'cliMissing') {
        child.emit(
          'error',
          Object.assign(new Error('spawn missing-claude ENOENT'), {
            code: 'ENOENT',
            path: launch.pathToClaudeCodeExecutable
          })
        )
      } else {
        child.stderr.write('--dangerously-skip-permissions cannot be used with root\n')
        child.emit('exit', 1, null)
      }
      child.stdout.end()
      child.stderr.end()
      child.emit('close', 1, null)
      expect(providerStartupFailureFact(await fault.promise)).toMatchObject({ kind })
      await connection.close()
    }
  )

  it.runIf(process.platform !== 'win32')(
    'reports lost parent outcome once through the real SDK',
    async () => {
      const faults: Error[] = []
      const exits: Error[] = []
      const rootsAtFault: string[] = []
      const scenario = scriptScenario([HOLD_OPEN])
      const connection = await open(launchFor(scenario), {
        onFault: (error) => {
          faults.push(error)
          rootsAtFault.push(connection.exitVerdict.root)
        },
        onExit: (error) => exits.push(error)
      })
      await connection.initializationResult()
      const parent = spawnedChildren[0]
      if (!parent) {
        throw new Error('Missing native parent')
      }
      parent.kill('SIGKILL')
      const error = await connection.exited
      expect(faults).toEqual([error])
      expect(rootsAtFault).toEqual(['exited'])
      expect(exits).toEqual([error])
      expect(providerStartupFailureFact(error)).toEqual({ kind: 'hostFault' })
      await connection.close()
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

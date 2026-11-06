import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  openClaudeStreamJsonConnection,
  type ClaudeStreamJsonConnection
} from './claude-stream-json-connection'
import { CLAUDE_STRUCTURED_BASE_OPTIONS } from './structured/launch/claude-structured-launch-resolution'

const scratch: string[] = []
const connections: ClaudeStreamJsonConnection[] = []
afterEach(async () => {
  for (const connection of connections.splice(0)) {
    await connection.close()
  }
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

it.each([true, false])(
  'sends the exact tool_use_id through the installed SDK and preserves backgrounded=%s',
  async (backgrounded) => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-background-contract-'))
    scratch.push(dir)
    const scenarioPath = join(dir, 'scenario.json')
    const reportPath = join(dir, 'report.json')
    writeFileSync(
      scenarioPath,
      JSON.stringify({
        controlResponses: { background_tasks: { backgrounded } },
        steps: [
          { awaitControlRequest: 'background_tasks' },
          { awaitFile: { path: join(dir, 'release'), timeoutMs: 10000 } }
        ]
      })
    )
    const connection = await openClaudeStreamJsonConnection({
      pathToClaudeCodeExecutable: join(
        __dirname,
        '__fixtures__',
        'claude-agent-sdk-scripted-cli.mjs'
      ),
      options: {
        ...CLAUDE_STRUCTURED_BASE_OPTIONS,
        sessionId: '5348c19f-6a54-4c2e-9c68-9c2b1a3d4e5f'
      },
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? '',
        ORCA_SDK_CONTRACT_SCENARIO_PATH: scenarioPath,
        ORCA_SDK_CONTRACT_REPORT_PATH: reportPath
      }
    })
    connections.push(connection)
    expect(await connection.backgroundTasks?.('toolu_running_build', { timeoutMs: 5000 })).toBe(
      backgrounded
    )
    const report: { controlRequests: { request: unknown }[]; userMessages: unknown[] } = JSON.parse(
      readFileSync(reportPath, 'utf8')
    )
    expect(
      report.controlRequests
        .map((frame) => frame.request)
        .filter(
          (request) =>
            typeof request === 'object' &&
            request !== null &&
            'subtype' in request &&
            request.subtype !== 'initialize'
        )
    ).toEqual([{ subtype: 'background_tasks', tool_use_id: 'toolu_running_build' }])
    expect(report.userMessages).toEqual([])
    expect(connection.closed).toBe(false)
    writeFileSync(join(dir, 'release'), '')
  },
  15000
)

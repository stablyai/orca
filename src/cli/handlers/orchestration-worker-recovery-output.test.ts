import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { tokenizeCommandLine } from '../../shared/agent-command-line-entrypoint'
import { RuntimeClient } from '../runtime-client'
import { ORCHESTRATION_WORKER_LAUNCH_HANDLER } from './orchestration/worker-launch-handler'

const originalExitCode = process.exitCode

afterEach(() => {
  process.exitCode = originalExitCode
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it.each([
  { executable: 'orca-dev', json: true, state: 'failed' },
  { executable: 'orca-dev', json: false, state: 'outcome_unknown' },
  { executable: 'orca-ide', json: true, state: 'outcome_unknown' },
  { executable: 'orca-ide', json: false, state: 'failed' }
])(
  'renders runnable $executable recovery commands for $state (json=$json)',
  async ({ executable, json, state }) => {
    vi.stubEnv('ORCA_CLI_COMMAND', executable)
    const client = new RuntimeClient('/verification/worker-recovery', 60_000, null, null)
    vi.spyOn(client, 'call').mockResolvedValue({
      id: 'worker-recovery',
      ok: true,
      _meta: { runtimeId: 'runtime_recovery' },
      result: {
        runId: 'run_recovery',
        taskId: 'task_recovery',
        dispatchId: 'ctx_recovery',
        state,
        effects: [],
        residualResources: [],
        nextCommands: [
          'orca orchestration worker-show --dispatch ctx_recovery --json',
          'orca orchestration worker-abandon --dispatch ctx_recovery --json'
        ]
      }
    })
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})

    await ORCHESTRATION_WORKER_LAUNCH_HANDLER['orchestration worker-start']({
      flags: new Map([
        ['task', 'task_recovery'],
        ['agent', 'codex'],
        ['from', 'term_coordinator']
      ]),
      client,
      cwd: '/verification/worker-recovery',
      json
    })

    const commands = [
      [executable, 'orchestration', 'worker-show', '--dispatch', 'ctx_recovery', '--json'],
      [executable, 'orchestration', 'worker-abandon', '--dispatch', 'ctx_recovery', '--json']
    ]
    const printed = output.mock.calls.map(([line]) => String(line)).join('\n')
    const renderedCommands = json
      ? z
          .object({ result: z.object({ nextCommands: z.array(z.string()) }) })
          .parse(JSON.parse(printed))
          .result.nextCommands.map(tokenizeCommandLine)
      : printed
          .split('\n')
          .map(tokenizeCommandLine)
          .map((tokens) => tokens.slice(tokens.indexOf(executable)))
          .filter((tokens) => tokens[0] === executable)
    expect(renderedCommands).toEqual(commands)
    expect(process.exitCode).toBe(1)
  }
)

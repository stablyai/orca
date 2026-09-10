import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeCommandPositionals, parseArgs, specPaths, validateCommandAndFlags } from './args'
import { BUNDLED_SKILL_GUIDES } from './bundled-skill-guides'
import { COMMAND_SPECS } from './specs'
import { applyVersionMatchedGuideContract } from './version-matched-guide-contract'
import { printResult } from './format'
import { formatWorkerStartReceipt } from './handlers/orchestration/worker-launch-handler'

afterEach(() => vi.restoreAllMocks())

const COMMAND_PATHS = COMMAND_SPECS.flatMap((spec) => specPaths(spec))

function markedCommands(markdown: string): string[] {
  return [...markdown.matchAll(/<!-- cli-contract:start -->[\s\S]*?<!-- cli-contract:end -->/g)]
    .flatMap(([block]) => block.split('\n'))
    .map((line) => line.trim())
    .filter((line) => /^(?:ORCA|orca) /.test(line))
}

describe('version-matched guide command contract', () => {
  it('parses every marked command against the live registry', () => {
    const commands = BUNDLED_SKILL_GUIDES.flatMap((guide) =>
      markedCommands(applyVersionMatchedGuideContract(guide.name, guide.markdown))
    )
    expect(commands.length).toBeGreaterThan(0)

    for (const command of commands) {
      const parsed = normalizeCommandPositionals(
        COMMAND_SPECS,
        parseArgs(command.split(/\s+/).slice(1), COMMAND_PATHS)
      )
      expect(() => validateCommandAndFlags(COMMAND_SPECS, parsed), command).not.toThrow()
    }
  })

  it('includes the required Attempt identity in every worker-start example', () => {
    const orchestration = BUNDLED_SKILL_GUIDES.find((guide) => guide.name === 'orchestration')
    const workerExamples = applyVersionMatchedGuideContract(
      orchestration?.name ?? '',
      orchestration?.markdown ?? ''
    )
      .split('\n')
      .filter((line) => line.includes('worker-start --task <'))

    expect(workerExamples?.length).toBeGreaterThan(0)
    for (const example of workerExamples ?? []) {
      expect(example).toContain('--attempt-id <attempt_id>')
    }
  })
})

describe('worker-start recovery output', () => {
  it('prints one copy-safe next command and preserves the complete JSON receipt', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const nextCommand =
      'orca orchestration replace-worker --task task_1 --predecessor dispatch_1 --json'
    const response = {
      id: 'request_1',
      ok: true as const,
      result: {
        runId: 'run_1',
        taskId: 'task_1',
        dispatchId: 'dispatch_1',
        state: 'outcome_unknown',
        failedStage: 'worktree_create',
        lastError: 'connection lost',
        nextCommands: [nextCommand],
        effects: [],
        residualResources: []
      },
      _meta: { runtimeId: 'runtime_1' }
    }

    printResult(response, false, formatWorkerStartReceipt)
    const humanOutput = String(log.mock.calls[0]?.[0])
    expect(humanOutput.match(/orca orchestration replace-worker/g)).toHaveLength(1)
    expect(humanOutput).toContain(`Next command: ${nextCommand}`)

    printResult(response, true, formatWorkerStartReceipt)
    expect(JSON.parse(String(log.mock.calls[1]?.[0]))).toMatchObject({
      result: { state: 'outcome_unknown', nextCommands: [nextCommand] }
    })
  })
})

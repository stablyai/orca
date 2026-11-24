// Opt-in benchmark: does a bot turn plain-English requests into the right automation?
// Spends real agent usage; run with `pnpm eval:bot-automations` (see the config for its knobs).
import { writeFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import {
  prepareStandIn,
  runBotTurn,
  type EvalAgent,
  type EvalOutcome
} from './bot-automation-eval-host'
import type { EvalScenario } from './bot-automation-eval-grading'
import { EVAL_SCENARIOS } from './bot-automation-eval-scenarios'
import { runBotThread } from '../bot-orchestration-eval/bot-orchestration-eval-conversation'
import { agentVersion } from '../bot-orchestration-eval/bot-orchestration-eval-report'

const agent: EvalAgent = process.env.ORCA_BOT_EVAL_AGENT === 'codex' ? 'codex' : 'claude'
const runs = Number(process.env.ORCA_BOT_EVAL_RUNS ?? 3)
const concurrency = Number(process.env.ORCA_BOT_EVAL_CONCURRENCY ?? 6)
const only = process.env.ORCA_BOT_EVAL_ONLY?.split(',').filter(Boolean)
const minPassRate = Number(process.env.ORCA_BOT_EVAL_MIN_PASS_RATE ?? 0)

/** The graded turn of a Chat that had earlier turns. */
async function runInThread(
  input: Parameters<typeof runBotTurn>[0] & Pick<EvalScenario, 'earlier'>
): Promise<EvalOutcome> {
  const { turns } = await runBotThread({
    agent: input.agent,
    standIn: input.standIn,
    state: { ...input.state, automations: input.automations },
    memory: input.memory,
    timeoutMs: input.timeoutMs,
    turns: [
      ...(input.earlier ?? []).map((turn) => ({
        message: turn.message,
        state: { ...input.state, ...turn.state }
      })),
      { message: input.message, state: input.state ?? {} }
    ]
  })
  const last = turns.at(-1)
  return {
    writes: last?.writes ?? [],
    commands: last?.commands ?? [],
    ownerTools: last?.ownerTools ?? [],
    reply: last?.reply ?? '',
    ...(last?.error ? { error: last.error } : {})
  }
}

type Result = { scenario: EvalScenario; run: number; failures: string[]; outcome: EvalOutcome }

async function pool<T>(jobs: (() => Promise<T>)[], size: number): Promise<T[]> {
  const results: T[] = []
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(size, jobs.length) }, async () => {
      while (next < jobs.length) {
        const index = next++
        results[index] = await jobs[index]!()
      }
    })
  )
  return results
}

function report(results: Result[], version: string): string {
  const categories = [...new Set(results.map((result) => result.scenario.category))]
  const line = (label: string, subset: Result[]) => {
    const passed = subset.filter((result) => result.failures.length === 0).length
    return `${label.padEnd(16)} ${String(passed).padStart(3)}/${String(subset.length).padEnd(3)} ${Math.round((100 * passed) / subset.length)}%`
  }
  const failures = results
    .filter((result) => result.failures.length)
    .map(
      (result) =>
        `- ${result.scenario.id} #${result.run}: ${result.failures.join('; ')}\n    reply: ${result.outcome.reply.replace(/\s+/g, ' ').slice(0, 300)}`
    )
  return [
    `bot automation eval (${agent} ${version}, model ${process.env.ORCA_BOT_EVAL_MODEL ?? 'CLI default'}, TZ ${process.env.TZ}, ${runs} runs each)`,
    ...categories.map((category) =>
      line(
        category,
        results.filter((result) => result.scenario.category === category)
      )
    ),
    line('total', results),
    '',
    ...failures
  ].join('\n')
}

it('turns requests into the right automations', { timeout: 4 * 60 * 60 * 1000 }, async () => {
  const scenarios = EVAL_SCENARIOS.filter(
    (scenario) => !only || only.includes(scenario.id) || only.includes(scenario.category)
  )
  const standIn = await prepareStandIn()
  try {
    const jobs = scenarios.flatMap((scenario) =>
      Array.from({ length: runs }, (_, run) => async (): Promise<Result> => {
        const outcome = await (scenario.earlier ? runInThread : runBotTurn)({
          agent,
          standIn: standIn.dir,
          message: scenario.message,
          automations: scenario.automations ?? [],
          state: scenario.state,
          memory: scenario.memory,
          earlier: scenario.earlier,
          timeoutMs: 5 * 60 * 1000
        })
        const failures = [...(outcome.error ? [outcome.error] : []), ...scenario.grade(outcome)]
        return { scenario, run: run + 1, failures, outcome }
      })
    )
    const results = await pool(jobs, concurrency)
    const text = report(results, await agentVersion(agent))
    process.stdout.write(`${text}\n`)
    if (process.env.ORCA_BOT_EVAL_OUT) {
      await writeFile(process.env.ORCA_BOT_EVAL_OUT, `${text}\n`)
      const detail = results.map(({ scenario, run, failures, outcome }) => ({
        id: scenario.id,
        run,
        failures,
        ...outcome
      }))
      await writeFile(`${process.env.ORCA_BOT_EVAL_OUT}.json`, JSON.stringify(detail, null, 2))
    }
    const passed = results.filter((result) => result.failures.length === 0).length
    expect(passed / results.length).toBeGreaterThanOrEqual(minPassRate)
  } finally {
    await standIn.dispose()
  }
})

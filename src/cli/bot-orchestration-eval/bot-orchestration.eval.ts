// Opt-in benchmark: does a bot hand code work to workers in the right project, follow up, and report
// back briefly? Spends real agent usage; run with `pnpm eval:bot-orchestration` (see the config for knobs).
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { prepareStandIn, type EvalAgent } from '../bot-automation-eval/bot-automation-eval-host'
import { installGitPushGuard } from './bot-orchestration-eval-checkout'
import { runBotThread, type EvalThreadOutcome } from './bot-orchestration-eval-conversation'
import {
  gradeThread,
  infrastructureFailure,
  replyStyle,
  type EvalFailure
} from './bot-orchestration-eval-grading'
import {
  ALL_ORCHESTRATION_SCENARIOS,
  type OrchestrationScenario
} from './bot-orchestration-eval-scenarios'
import { agentVersion, wilson } from './bot-orchestration-eval-report'

const agent: EvalAgent = process.env.ORCA_BOT_EVAL_AGENT === 'codex' ? 'codex' : 'claude'
const runs = Number(process.env.ORCA_BOT_EVAL_RUNS ?? 2)
const concurrency = Number(process.env.ORCA_BOT_EVAL_CONCURRENCY ?? 6)
const only = process.env.ORCA_BOT_EVAL_ONLY?.split(',').filter(Boolean)
const minPassRate = Number(process.env.ORCA_BOT_EVAL_MIN_PASS_RATE ?? 0)

type Result = {
  scenario: OrchestrationScenario
  run: number
  failures: EvalFailure[]
  /** The harness or agent CLI broke; not counted for or against the bot. */
  infrastructure: string | null
  thread: EvalThreadOutcome
}

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

function graded(results: Result[]): Result[] {
  return results.filter((result) => !result.infrastructure)
}

/** Passes over graded runs, with a 95% interval, and how many runs the infrastructure lost. */
function rate(results: Result[]): string {
  const counted = graded(results)
  const passed = counted.filter((result) => result.failures.length === 0).length
  const [low, high] = wilson(passed, counted.length)
  const infra = results.length - counted.length
  return `${passed}/${counted.length} [${low}-${high}%]${infra ? ` infra ${infra}` : ''}`
}

/** What the agent reported spending across every turn (Claude only). */
function cost(results: Result[]): number {
  return results
    .flatMap((result) => result.thread.turns)
    .reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0)
}

/** Reply style, reported only: the owner sets it through the soul. */
function style(results: Result[]): string {
  const replies = results.flatMap((result) =>
    result.thread.turns.map((turn) => replyStyle(turn.reply))
  )
  const words = replies.map((reply) => reply.words).sort((a, b) => a - b)
  const median = words[Math.floor(words.length / 2)] ?? 0
  const ids = replies.filter((reply) => reply.ids).length
  const paths = replies.filter((reply) => reply.paths).length
  return `words median ${median} max ${words.at(-1) ?? 0}, ids ${ids}/${replies.length}, paths ${paths}/${replies.length}`
}

function report(results: Result[], version: string, pending: OrchestrationScenario[]): string {
  const ids = [...new Set(results.map((result) => result.scenario.id))]
  const rows = ids.map((id) => {
    const subset = results.filter((result) => result.scenario.id === id)
    return `${id.padEnd(34)} pass ${rate(subset).padEnd(24)} ${style(subset)}`
  })
  const failures = graded(results)
    .filter((result) => result.failures.length)
    .map((result) => `- ${result.scenario.id} #${result.run}: ${result.failures.join('; ')}`)
  const broken = results
    .filter((result) => result.infrastructure)
    .map((result) => `- ${result.scenario.id} #${result.run}: ${result.infrastructure}`)
  return [
    `bot orchestration eval (${agent} ${version}, model ${process.env.ORCA_BOT_EVAL_MODEL ?? 'CLI default'}, TZ ${process.env.TZ}, ${runs} runs each)`,
    ...rows,
    `${'total'.padEnd(34)} pass ${rate(results).padEnd(24)} ${style(results)}`,
    `${'held out'.padEnd(34)} pass ${rate(results.filter((result) => result.scenario.heldOut))}`,
    `${'cost'.padEnd(34)} $${cost(results).toFixed(2)}`,
    ...(pending.length
      ? [
          '',
          'pending:',
          ...pending.map((scenario) => `- ${scenario.id}: waits on ${scenario.pending}`)
        ]
      : []),
    '',
    ...failures,
    ...(broken.length ? ['', 'infrastructure (not graded):', ...broken] : [])
  ].join('\n')
}

it('hands code work to workers and reports back', { timeout: 4 * 60 * 60 * 1000 }, async () => {
  const chosen = ALL_ORCHESTRATION_SCENARIOS.filter(
    (scenario) => !only || only.includes(scenario.id)
  )
  const scenarios = chosen.filter((scenario) => !scenario.pending)
  // Without it the orca project has no files: a bot can't dig in, or read before handing off.
  if (!process.env.ORCA_BOT_EVAL_ORCA_CHECKOUT) {
    throw new Error('Set ORCA_BOT_EVAL_ORCA_CHECKOUT to a clean orca checkout the bots may read.')
  }
  const version = await agentVersion(agent)
  const standIn = await prepareStandIn()
  try {
    await installGitPushGuard(standIn.dir)
    const jobs = scenarios.flatMap((scenario) =>
      Array.from({ length: runs }, (_, run) => async (): Promise<Result> => {
        const thread = await runBotThread({
          agent,
          standIn: standIn.dir,
          turns: scenario.turns,
          state: scenario.state,
          soul: scenario.soul,
          memory: scenario.memory,
          firstRun: scenario.firstRun,
          botName: scenario.botName,
          timeoutMs: 6 * 60 * 1000
        })
        return {
          scenario,
          run: run + 1,
          failures: gradeThread(thread, scenario.checks),
          infrastructure: infrastructureFailure(thread),
          thread
        }
      })
    )
    const results = await pool(jobs, concurrency)
    const text = report(
      results,
      version,
      chosen.filter((scenario) => scenario.pending)
    )
    process.stdout.write(`${text}\n`)
    const out = process.env.ORCA_BOT_EVAL_OUT
    if (out) {
      await writeFile(out, `${text}\n`)
      await mkdir(`${out}.transcripts`, { recursive: true })
      for (const result of results) {
        await writeFile(
          join(`${out}.transcripts`, `${result.scenario.id}-${result.run}.txt`),
          result.thread.transcript
        )
      }
    }
    const counted = graded(results)
    const passed = counted.filter((result) => result.failures.length === 0).length
    expect(passed / Math.max(counted.length, 1)).toBeGreaterThanOrEqual(minPassRate)
  } finally {
    await standIn.dispose()
  }
})

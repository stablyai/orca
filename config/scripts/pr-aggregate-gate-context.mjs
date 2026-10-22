import { readFileSync } from 'node:fs'
import { Evaluator, Lexer, Parser, data } from '@actions/expressions'
import { parse } from 'yaml'
import { PR_CHECK_JOBS } from './pr-code-change-scope.mjs'

export const aggregateWorkflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
export const aggregateJob = aggregateWorkflow.jobs.verify
export const aggregateShell = aggregateJob.steps.find(
  (step) => step.name === 'Require successful checks'
)
export const aggregateSelectors = PR_CHECK_JOBS.filter((job) => job !== 'orcad_browser')
export const aggregateRequiredJobs = aggregateJob.needs.filter((job) => job !== 'code_paths')
export const aggregateVariable = (job) => job.replaceAll('-', '_').toUpperCase()

export function compileAggregateExpression(expression, contexts = ['needs']) {
  const source = expression.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
  const functions = [{ name: 'cancelled', minArgs: 0, maxArgs: 0 }]
  const ast = new Parser(new Lexer(source).lex().tokens, contexts, functions).parse()
  return (context, cancelled = false) =>
    new Evaluator(
      ast,
      JSON.parse(JSON.stringify(context), data.reviver),
      new Map([['cancelled', { ...functions[0], call: () => new data.BooleanData(cancelled) }]])
    ).evaluate()
}

export const aggregateShouldRun = compileAggregateExpression(aggregateJob.if, ['needs', 'github'])
const aggregateEnvironmentExpressions = Object.fromEntries(
  Object.entries(aggregateShell.env).map(([name, expression]) => [
    name,
    compileAggregateExpression(expression)
  ])
)

export function aggregateEnvironment(needs) {
  return Object.fromEntries(
    Object.entries(aggregateEnvironmentExpressions).map(([name, evaluate]) => [
      name,
      evaluate({ needs }).coerceString()
    ])
  )
}

export function aggregateNeeds(selected = 'true', overrides = {}) {
  const outputs = {
    should_run: 'true',
    ...Object.fromEntries(aggregateSelectors.map((job) => [job, selected])),
    ...overrides
  }
  const needs = {
    code_paths: { result: 'success', outputs },
    ...Object.fromEntries(
      aggregateRequiredJobs.map((job) => [
        job,
        { result: outputs[job] === 'true' ? 'success' : 'skipped' }
      ])
    )
  }
  needs.preflight.result =
    aggregateEnvironmentExpressions.PREFLIGHT_SHOULD_RUN({ needs }).coerceString() === 'true'
      ? 'success'
      : 'skipped'
  return needs
}

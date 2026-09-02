import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

// Why: pr.yml re-lists the `lint` chain as individual steps so a single failure
// does not mask the rest and oxlint keeps its `--format github` annotations.
// Hand-maintained mirrors drift (#10601: three verifiers never ran on PRs), so
// this gate fails the moment a `lint` step has no counterpart in pr.yml.

// Flags that only change reporting, so they must not split two otherwise identical commands.
const REPORTING_FLAGS_WITH_VALUE = new Set(['--format', '--reporter'])
const REPORTING_FLAGS = new Set(['--quiet'])
const PACKAGE_RUNNER_TOKENS = new Set(['pnpm', 'npm', 'yarn', 'npx', 'run', 'exec', 'node'])

function splitCommandChain(command) {
  return command
    .split(/\n|&&|;/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function canonicalize(command) {
  const tokens = command.split(/\s+/)
  const canonical = []

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (canonical.length === 0 && PACKAGE_RUNNER_TOKENS.has(token)) {
      continue
    }
    if (REPORTING_FLAGS.has(token)) {
      continue
    }
    if (REPORTING_FLAGS_WITH_VALUE.has(token)) {
      index += 1
      continue
    }
    canonical.push(token)
  }

  return canonical.join(' ')
}

/** Expands `pnpm run x` indirection until every entry is a real binary invocation. */
function resolveLeafCommands(command, scripts, seen = new Set()) {
  const leaves = []

  for (const part of splitCommandChain(command)) {
    const scriptName = part.match(/^(?:pnpm|npm|yarn)(?:\s+run)?\s+([\w:-]+)$/)?.[1]
    if (scriptName && scripts[scriptName] && !seen.has(scriptName)) {
      leaves.push(
        ...resolveLeafCommands(scripts[scriptName], scripts, new Set([...seen, scriptName]))
      )
      continue
    }
    leaves.push(canonicalize(part))
  }

  return leaves
}

describe('PR workflow lint parity', () => {
  it('runs every `pnpm lint` step on pull requests', () => {
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8'))
    const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))

    // Scan every job: which one hosts the lint steps is an organizational
    // detail that has already been renamed once (verify -> static_analysis).
    const workflowCommands = new Set(
      Object.values(workflow.jobs)
        .flatMap((job) => job.steps ?? [])
        .filter((step) => typeof step.run === 'string')
        .flatMap((step) => resolveLeafCommands(step.run, scripts))
    )

    const missing = resolveLeafCommands(scripts.lint, scripts).filter(
      (leaf) => !workflowCommands.has(leaf)
    )

    expect(
      missing,
      `.github/workflows/pr.yml is missing lint steps: ${missing.join(', ')}. ` +
        'Add a step for each one so PR CI matches `pnpm lint`.'
    ).toEqual([])
  })
})

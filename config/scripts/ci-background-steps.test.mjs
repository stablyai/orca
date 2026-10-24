import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { expect, it } from 'vitest'

// Why: the runner rewrites $GITHUB_EVENT_PATH in place (truncate, then write) at every step start,
// and background steps start on their own task. A JavaScript action (@actions/github parses the
// payload at import) or composite (its inner steps start later) in the background therefore races
// the foreground's step starts and reads an empty file: "Unexpected end of JSON input".
const workflowFiles = readdirSync('.github/workflows')
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => join('.github/workflows', name))
const actionFiles = readdirSync('.github/actions')
  .map((name) => join('.github/actions', name, 'action.yml'))
  .filter((file) => existsSync(file))

// Single-step JavaScript actions whose bundle never reads the payload (checked by searching dist/index.js).
const payloadFreeActions = ['ruby/setup-ruby@v1']
// The runner runs 10 at once; a queued step starts (and rewrites the payload) mid-foreground-step.
const backgroundSlots = 10

function stepLists(file) {
  const document = parse(readFileSync(file, 'utf8'))
  return document.jobs
    ? Object.entries(document.jobs).map(([job, value]) => [job, value.steps ?? []])
    : [['composite', document.runs?.steps ?? []]]
}

function backgroundSteps() {
  const found = []
  for (const file of [...workflowFiles, ...actionFiles]) {
    for (const [job, steps] of stepLists(file)) {
      for (const step of steps) {
        if (step.background) {
          found.push({ where: `${file} ${job} ${step.id ?? step.name}`, step })
        }
      }
    }
  }
  return found
}

function readsEventPayload(run) {
  const scripts = [...run.matchAll(/(?:config\/scripts|\.github\/actions)\/[\w./-]+/g)].map(
    (match) => match[0]
  )
  return (
    run.includes('GITHUB_EVENT_PATH') ||
    scripts.some(
      (file) =>
        existsSync(file) &&
        statSync(file).isFile() &&
        readFileSync(file, 'utf8').includes('GITHUB_EVENT_PATH')
    )
  )
}

it('finds the background steps it guards', () => {
  expect(backgroundSteps().length).toBeGreaterThan(0)
})

it('backgrounds only single run steps, never actions that start later steps or parse the payload', () => {
  const actions = backgroundSteps()
    .filter(({ step }) => typeof step.run !== 'string' && !payloadFreeActions.includes(step.uses))
    .map(({ where }) => where)
  expect(actions).toEqual([])
})

it('keeps the event payload out of background run steps', () => {
  const readers = backgroundSteps()
    .filter(({ step }) => typeof step.run === 'string' && readsEventPayload(step.run))
    .map(({ where }) => where)
  expect(readers).toEqual([])
})

it('never queues a background step behind a full slot pool', () => {
  const crowded = []
  for (const file of workflowFiles) {
    for (const [job, steps] of stepLists(file)) {
      const open = new Set()
      for (const [index, step] of steps.entries()) {
        if (step.background) {
          open.add(step.id ?? index)
        }
        for (const id of [step.wait ?? []].flat()) {
          open.delete(id)
        }
        if (open.size > backgroundSlots) {
          crowded.push(`${file} ${job}`)
        }
      }
    }
  }
  expect(crowded).toEqual([])
})

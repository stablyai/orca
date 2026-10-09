import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')
const e2eWorkflow = parse(readFileSync(join(projectDir, '.github/workflows/e2e.yml'), 'utf8'))

it('gives every Docker-gated SSH spec a lane that runs it', () => {
  // Why this shape: the sharded lanes set no ORCA_E2E_SSH_DOCKER, so a Docker-gated spec
  // that no runner names runs nowhere and still reports green — the silent skip this file
  // exists to prevent. Asserting reachability rather than a literal keeps that true when
  // the lanes move.
  // The remaining exemption needs performance validation before routine CI, recorded in
  // run-ssh-docker-e2e.mjs so the gap stays legible rather than looking like coverage.
  const unreachableSpecs = new Set(['tests/e2e/ssh-docker-relay-perf.spec.ts'])
  // Why comments are stripped: the runner documents the exempt spec by name in a
  // prose comment. A substring scan over raw text would count any spec merely *discussed* in a
  // runner as claimed by it -- the silent skip this assertion exists to catch, re-entering
  // through the documentation.
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const laneRunners = [
    'run-ssh-docker-e2e.mjs',
    'run-ssh-docker-watcher-isolation-e2e.mjs',
    'run-ssh-docker-terminal-parking-e2e.mjs'
  ].map((file) => stripComments(readFileSync(join(projectDir, 'config/scripts', file), 'utf8')))
  const managedLane = e2eWorkflow.jobs['orcad-auto-convert-docker']
  const managedRun = managedLane.steps.find(
    (step) => step.name === 'Convert a relay-era Docker host'
  )
  expect(managedRun.env.ORCA_E2E_SSH_DOCKER).toBe('1')
  expect(managedRun.run).toContain('ORCA_E2E_ORCAD_CONVERT_TEMPLATE=')
  laneRunners.push(stripComments(managedRun.run))

  // Why a comparison and not the bare name: preview and demo specs cite the flag in a
  // "how to run me" comment without gating on it. Why a regex rather than one literal: an
  // equally-valid spelling (double quotes, or a `!==` guard) would escape a fixed-string scan
  // and the spec would silently leave the contract.
  const dockerGateExpression = /ORCA_E2E_SSH_DOCKER\s*[!=]==\s*['"]1['"]/
  const dockerGatedSpecs = readdirSync(join(projectDir, 'tests/e2e'))
    .filter((file) => file.endsWith('.spec.ts'))
    .map((file) => `tests/e2e/${file}`)
    .filter((spec) => dockerGateExpression.test(readFileSync(join(projectDir, spec), 'utf8')))
  expect(dockerGatedSpecs.length).toBeGreaterThan(0)

  const unclaimed = dockerGatedSpecs.filter(
    (spec) => !unreachableSpecs.has(spec) && !laneRunners.some((runner) => runner.includes(spec))
  )
  expect(
    unclaimed,
    `Docker-gated specs claimed by no lane runner: ${unclaimed.join(', ')}`
  ).toEqual([])

  // Why: an exemption that outlives its spec would quietly excuse a real gap.
  for (const spec of unreachableSpecs) {
    expect(dockerGatedSpecs, spec).toContain(spec)
    // Why also assert absence from every runner: `unreachableSpecs` short-circuits the
    // unclaimed check above, so a spec could be documented as exempt while a runner still
    // invokes it -- an exemption that reads as coverage removal but changes nothing, and a
    // lane that stays red for a reason the file says it excluded.
    for (const runner of laneRunners) {
      expect(runner.includes(spec), `${spec} is exempt but still invoked by a lane runner`).toBe(
        false
      )
    }
  }

  const laneStep = e2eWorkflow.jobs['ssh-docker-watcher-isolation'].steps.find(
    (step) => step.name === 'Run remaining Docker SSH E2E'
  )
  expect(laneStep.run).toContain('test:e2e:ssh-docker')
  // Why: the added serial tests, several budgeting 4-10 minutes each, do not fit the old 35.
  expect(
    e2eWorkflow.jobs['ssh-docker-watcher-isolation']['timeout-minutes']
  ).toBeGreaterThanOrEqual(60)
})

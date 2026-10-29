import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { compileAggregateExpression } from './pr-aggregate-gate-context.mjs'
import { WSL_FAMILIES } from './wsl-orcad-qualification.mjs'

const workflow = parse(readFileSync('.github/workflows/wsl-orcad-e2e.yml', 'utf8'))
const select = workflow.jobs.template.steps.find((step) => step.id === 'scope')
const families = (outputs) => {
  const expression = workflow.jobs.wsl2.strategy.matrix.family.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
  const evaluate = compileAggregateExpression(`toJSON(${expression})`, ['needs'])
  return JSON.parse(evaluate({ needs: { template: { outputs } } }).coerceString())
}

it('selects the Ubuntu canary without adding a detector runner or changing prerequisites', () => {
  expect(families({ families: '["ubuntu-24.04"]' })).toEqual(['ubuntu-24.04'])
  expect(workflow.jobs.wsl2.needs).toEqual(['template', 'container-rootfs'])
  expect(workflow.jobs.wsl2.if).toBeUndefined()
  expect(workflow.jobs.template.steps.indexOf(select)).toBeGreaterThan(
    workflow.jobs.template.steps.findIndex(
      (step) => step.uses === './.github/actions/install-node-dependencies'
    )
  )
})

it.each([{}, { families: '' }])(
  'fails closed to all families when selection is unavailable: %j',
  (outputs) => {
    expect(families(outputs)).toEqual(WSL_FAMILIES)
    expect(select['continue-on-error']).toBe(true)
    const output = compileAggregateExpression(workflow.jobs.template.outputs.families, ['steps'])
    expect(
      output({
        steps: { scope: { outcome: 'failure', outputs: { families: '["ubuntu-24.04"]' } } }
      }).coerceString()
    ).toBe('')
  }
)

it('retains both systemd modes on Ubuntu and full scheduled/manual references', () => {
  expect(workflow.on).toHaveProperty('schedule')
  expect(workflow.on).toHaveProperty('workflow_dispatch')
  for (const family of WSL_FAMILIES) {
    const evaluate = compileAggregateExpression(workflow.jobs.wsl2.env.SYSTEMD_DISTRO, ['matrix'])
    expect(evaluate({ matrix: { family } }).coerceString()).toBe(
      family === 'ubuntu-24.04' ? 'orca-lane-systemd' : ''
    )
  }
  const phases = workflow.jobs.wsl2.steps.filter(
    (step) => step.env?.ORCA_RUN_WSL_ORCAD_LANE === '1'
  )
  expect(phases.map((step) => step.env.ORCA_WSL_ORCAD_LANE_PHASE)).toEqual([
    'launch',
    'survive',
    'idle-release'
  ])
})

import { describe, expect, it } from 'vitest'
import { workflowMatrixRunnerLabels } from './workflow-matrix-runner-labels.mjs'

const RUNS_ON = "${{ matrix.runner || 'ubuntu-latest' }}"

describe('workflowMatrixRunnerLabels', () => {
  it('reads every leg, taking the fallback where a leg names no runner', () => {
    const job = {
      'runs-on': RUNS_ON,
      strategy: {
        matrix: {
          include: [
            { node: '22' },
            { node: '22', runner: 'macos-latest' },
            { runner: 'ubuntu-24.04-arm' }
          ]
        }
      }
    }
    expect(workflowMatrixRunnerLabels(job)).toEqual([
      'ubuntu-latest',
      'macos-latest',
      'ubuntu-24.04-arm'
    ])
  })

  it('surfaces a Windows leg', () => {
    const job = {
      'runs-on': '${{ matrix.os }}',
      strategy: { matrix: { os: ['ubuntu-latest', 'windows-latest'] } }
    }
    expect(workflowMatrixRunnerLabels(job)).toEqual(['ubuntu-latest', 'windows-latest'])
  })

  it('leaves anything it cannot resolve as the original expression', () => {
    const unresolvable = [
      { 'runs-on': '${{ inputs.runner }}', strategy: { matrix: { include: [] } } },
      { 'runs-on': RUNS_ON, strategy: { matrix: '${{ fromJSON(needs.plan.outputs.matrix) }}' } },
      { 'runs-on': RUNS_ON, strategy: { matrix: { include: [{ runner: '${{ vars.RUNNER }}' }] } } },
      { 'runs-on': '${{ matrix.runner }}', strategy: { matrix: { include: [{ node: '22' }] } } },
      { 'runs-on': RUNS_ON }
    ]
    for (const job of unresolvable) {
      expect(workflowMatrixRunnerLabels(job)).toBe(job['runs-on'])
    }
  })

  it('passes a literal runs-on through', () => {
    expect(workflowMatrixRunnerLabels({ 'runs-on': 'windows-2022' })).toBe('windows-2022')
  })
})

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')
const dailyWorkflow = parse(
  readFileSync(join(projectDir, '.github/workflows/daily-mac-build.yml'), 'utf8')
)
const e2eWorkflow = parse(readFileSync(join(projectDir, '.github/workflows/e2e.yml'), 'utf8'))

describe('daily E2E dispatch contract', () => {
  it('dispatches SHA-scoped full E2E only after a live daily publish', () => {
    const buildJob = dailyWorkflow.jobs['build-daily-mac']
    const dispatchJob = dailyWorkflow.jobs['post-daily-e2e']
    const dispatchStep = dispatchJob.steps.find((step) => step.name === 'Dispatch cut-scoped E2E')

    expect(dailyWorkflow.jobs.e2e).toBeUndefined()
    expect(buildJob.outputs.head_sha).toBe('${{ steps.freshness.outputs.head_sha }}')
    expect(buildJob.outputs.published).toBe(
      "${{ steps.publish_live.outcome == 'success' && 'true' || 'false' }}"
    )
    expect(dispatchJob.needs).toBe('build-daily-mac')
    expect(dispatchJob.if).toBe(
      "${{ needs.build-daily-mac.outputs.published == 'true' && needs.build-daily-mac.outputs.head_sha != '' }}"
    )
    expect(dispatchJob.permissions.actions).toBe('write')
    expect(dispatchStep.env.SHA).toBe('${{ needs.build-daily-mac.outputs.head_sha }}')
    expect(dispatchStep.run).toContain('gh workflow run e2e.yml')
    expect(dispatchStep.run).toContain('--ref main')
    expect(dispatchStep.run).toContain('--raw-field "ref=$SHA"')
    expect(dispatchStep.run).toContain('for attempt in 1 2 3')
    expect(dispatchStep.run).toContain('[[ "$attempt" -eq 3 ]] || sleep')
    expect(dispatchStep.run).toContain('::warning::Failed to dispatch post-daily E2E')
  })

  it('leaves test_files unset so the dispatched run takes the full suite', () => {
    const dispatchJob = dailyWorkflow.jobs['post-daily-e2e']
    const dispatchStep = dispatchJob.steps.find((step) => step.name === 'Dispatch cut-scoped E2E')

    expect(dispatchStep.run).not.toContain('test_files')
    expect(e2eWorkflow.on.workflow_call.inputs.test_files.required).toBe(false)
    expect(e2eWorkflow.jobs.e2e.if).toBe("inputs.test_files == ''")
  })
})

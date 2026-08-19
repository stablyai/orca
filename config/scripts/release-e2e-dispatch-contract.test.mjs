import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')
const releaseWorkflow = parse(
  readFileSync(join(projectDir, '.github/workflows/release-cut.yml'), 'utf8')
)
const e2eWorkflow = parse(readFileSync(join(projectDir, '.github/workflows/e2e.yml'), 'utf8'))

describe('release E2E dispatch contract', () => {
  it('dispatches tag-scoped E2E only after publication', () => {
    const dispatchJob = releaseWorkflow.jobs['post-release-e2e']
    const dispatchStep = dispatchJob.steps.find((step) => step.name === 'Dispatch tag-scoped E2E')

    expect(releaseWorkflow.jobs.e2e).toBeUndefined()
    expect(dispatchJob.needs).toEqual(['cut', 'publish-release'])
    expect(dispatchJob.if).toBe("${{ needs.cut.outputs.tag != '' }}")
    expect(dispatchJob.permissions.actions).toBe('write')
    expect(dispatchStep.env.TAG).toBe('${{ needs.cut.outputs.tag }}')
    expect(dispatchStep.run).toContain('gh workflow run e2e.yml')
    expect(dispatchStep.run).toContain('--ref "$TAG"')
    expect(dispatchStep.run).toContain('--raw-field "ref=refs/tags/$TAG"')
    expect(dispatchStep.run).toContain('for attempt in 1 2 3')
    expect(dispatchStep.run).toContain('[[ "$attempt" -eq 3 ]] || sleep')
    expect(dispatchStep.run).toContain('::warning::Failed to dispatch post-release E2E')
  })

  it('keeps detached E2E identifiable and manually dispatchable by ref', () => {
    const refInput = e2eWorkflow.on.workflow_dispatch.inputs.ref

    expect(e2eWorkflow['run-name']).toBe('E2E ${{ inputs.ref || github.ref }}')
    expect(refInput.type).toBe('string')
    expect(refInput.required).toBe(false)
  })

  it('includes the paired-runtime web client in the shared E2E build artifact', () => {
    const buildStep = e2eWorkflow.jobs.build.steps.find((step) => step.name === 'Build E2E outputs')

    expect(buildStep.run).toContain('electron-vite build --mode e2e')
    expect(buildStep.env.VITE_EXPOSE_STORE).toBe('true')
    expect(buildStep.run).toContain('pnpm run build:web-from-renderer')
    expect(buildStep.run).toContain('pnpm run build:relay')
  })

  it('hands the built relay artifact to every E2E run command', () => {
    const uploadStep = e2eWorkflow.jobs.build.steps.find(
      (step) => step.name === 'Upload E2E build output'
    )

    expect(uploadStep.with.name).toBe('e2e-build-out')
    expect(uploadStep.with.path).toBe('out/')

    for (const [jobName, runStepName] of [
      ['e2e', 'Run E2E tests (${{ matrix.shard_name }})'],
      ['changed-e2e', 'Run changed E2E specs']
    ]) {
      const job = e2eWorkflow.jobs[jobName]
      const downloadStep = job.steps.find((step) => step.name === 'Download E2E build output')
      const runStep = job.steps.find((step) => step.name === runStepName)

      expect(job.needs).toBe('build')
      expect(downloadStep.with.name).toBe('e2e-build-out')
      expect(downloadStep.with.path).toBe('out/')
      expect(runStep.run).toContain('ORCA_RELAY_PATH="$GITHUB_WORKSPACE/out/relay"')
    }
  })
})

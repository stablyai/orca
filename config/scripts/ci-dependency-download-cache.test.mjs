import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const read = (path) => parse(readFileSync(path, 'utf8'))
const workflow = (name) => read(`.github/workflows/${name}.yml`)
const action = read('.github/actions/install-node-dependencies/action.yml')

describe('CI dependency download caches', () => {
  it('scopes desktop stores to the root lockfile and lets mixed installs opt in', () => {
    expect(action.inputs['cache-dependency-path'].default).toBe('pnpm-lock.yaml')
    for (const step of action.runs.steps.filter((step) => step.uses === 'actions/setup-node@v6')) {
      expect(step.with.cache).toBe('pnpm')
      expect(step.with['cache-dependency-path']).toBe('${{ inputs.cache-dependency-path }}')
    }
    const install = action.runs.steps.find((step) => step.name === 'Install dependencies')
    expect(install.if).toBeUndefined()
    expect(install.run).toContain('pnpm install --frozen-lockfile --ignore-scripts')
    expect(install.run).toContain(
      'diff --exit-code -- package.json pnpm-lock.yaml pnpm-workspace.yaml'
    )
    const mobile = workflow('mobile').jobs.verify.steps.find((step) =>
      step.uses?.includes('install-node-dependencies')
    )
    expect(mobile.with['cache-dependency-path'].trim().split('\n')).toEqual([
      'pnpm-lock.yaml',
      'mobile/pnpm-lock.yaml'
    ])
  })

  it('saves release tool downloads before signing can mutate them', () => {
    const steps = Object.values(workflow('release-cut').jobs).find((job) =>
      job.steps?.some((step) => step.id === 'electron-builder-downloads')
    ).steps
    const restore = steps.find((step) => step.id === 'electron-builder-downloads')
    const save = steps.find(
      (step) => step.name === 'Save electron-builder downloads before signing'
    )
    expect(restore.uses).toBe('actions/cache/restore@v5')
    expect(restore.with.key).toContain(
      'electron-builder-downloads-v2-${{ runner.os }}-${{ runner.arch }}'
    )
    expect(restore.with['restore-keys']).toContain('electron-builder-downloads-v2-')
    expect(save.uses).toBe('actions/cache/save@v5')
    expect(save.with.path).toBe(restore.with.path)
    expect(save.with.key).toBe('${{ steps.electron-builder-downloads.outputs.cache-primary-key }}')
    expect(steps.indexOf(save)).toBeGreaterThan(
      steps.findIndex((step) => step.name === 'Build Windows release artifacts')
    )
    expect(steps.indexOf(save)).toBeLessThan(
      steps.findIndex((step) => step.id === 'sign-elevate-cache')
    )
    expect(save.if).toContain("matrix.platform != 'win' || github.run_attempt == 1")
  })
})

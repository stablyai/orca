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
      expect(step.with.cache).toBe("${{ github.event_name != 'pull_request' && 'pnpm' || '' }}")
      expect(step.with['cache-dependency-path']).toBe('${{ inputs.cache-dependency-path }}')
      expect(step.with['package-manager-cache']).toBe(false)
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

  it('restores PR stores with setup-node keys without registering a post-job save', () => {
    const resolve = action.runs.steps.find((step) => step.id === 'pnpm-store')
    const restore = action.runs.steps.find(
      (step) => step.name === 'Restore pnpm download store without saving'
    )
    expect(resolve.if).toBe("github.event_name == 'pull_request'")
    expect(restore.if).toBe(resolve.if)
    expect(restore.uses).toBe('actions/cache/restore@v5')
    expect(restore.with.path).toBe('${{ steps.pnpm-store.outputs.path }}')
    expect(restore.with.key).toBe(
      'node-cache-${{ runner.os }}-${{ steps.pnpm-store.outputs.arch }}-pnpm-${{ hashFiles(inputs.cache-dependency-path) }}'
    )
    expect(restore.with['restore-keys']).toBeUndefined()
    expect(resolve.env.LOCKFILE_HASH).toBe('${{ hashFiles(inputs.cache-dependency-path) }}')
    expect(action.runs.steps.indexOf(resolve)).toBeLessThan(action.runs.steps.indexOf(restore))
    expect(action.runs.steps.indexOf(restore)).toBeLessThan(
      action.runs.steps.findIndex((step) => step.name === 'Install dependencies')
    )
    const saves = action.runs.steps.filter((step) => step.uses === 'actions/cache/save@v5')
    expect(saves).toEqual([])
  })
})

describe('release install targets', () => {
  const macCpuFlag = '--cpu=current,x64,arm64'
  // Both shapes: `run:` steps and steps wrapped in nick-fields/retry (`with.command`).
  const installCommand = (step) => step.with?.command ?? step.run
  const installSteps = (name) =>
    Object.values(workflow(name).jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((step) => installCommand(step)?.includes('pnpm install '))
  const installCommands = (name) => installSteps(name).map(installCommand)

  it.each(['adhoc-mac-build', 'daily-mac-build', 'hourly-mac-build', 'release-mac-build'])(
    '%s installs both mac CPU variants for the x64+arm64 package config',
    (name) => {
      const installs = installCommands(name)
      expect(installs.length).toBeGreaterThan(0)
      expect(installs.some((command) => command.includes(macCpuFlag))).toBe(true)
    }
  )

  // A transient `read ECONNRESET` fetching this Node version's headers for
  // native/windows-registry's node-gyp rebuild failed a blocking golden gate and the cut.
  it('retries every release-cut install so one transient download cannot fail a cut', () => {
    const installs = installSteps('release-cut')
    expect(installs.length).toBeGreaterThan(0)
    for (const step of installs) {
      expect(step.uses).toBe('nick-fields/retry@v4')
      expect(step.with.max_attempts).toBeGreaterThan(1)
    }
  })

  it.each(['release-cut', 'dev-channel-win-build', 'windows-signing-rehearsal'])(
    '%s keeps installs scoped to the runner host',
    (name) => {
      const installs = installCommands(name)
      expect(installs.length).toBeGreaterThan(0)
      for (const command of installs) {
        expect(command).not.toContain('--os=')
        expect(command).not.toContain('--cpu=')
      }
    }
  )

  it('offers the mac CPU targets for local packaging without touching the lockfile', () => {
    const script = JSON.parse(readFileSync('package.json', 'utf8')).scripts['install:release']
    expect(script).toContain('--frozen-lockfile')
    expect(script).toContain(macCpuFlag)
  })

  it('keeps installed Windows addon checks in the Windows CI lane', () => {
    const steps = Object.values(workflow('pr').jobs).flatMap((job) => job.steps ?? [])
    const test = steps.find((step) => step.name === 'Test Windows-specific boundaries')
    expect(test.run).toContain('config/scripts/windows-process-tree-gyp-path.test.mjs')
    expect(test.run).toContain('config/scripts/windows-process-tree-gyp-rebuild.test.mjs')
    expect(test.run).toContain('config/scripts/package-electron-runtime-contract.test.mjs')
    expect(test.run).toContain('config/scripts/electron-builder-runtime-resources.test.mjs')
  })
})

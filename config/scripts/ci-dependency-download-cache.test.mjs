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

  it.each(['mobile-android-release', 'mobile-ios-release'])(
    '%s caches its own lockfile and always performs a frozen install and native generation',
    (name) => {
      const steps = Object.values(workflow(name).jobs)[0].steps
      const node = steps.findIndex((step) => step.uses === 'actions/setup-node@v6')
      expect(steps.findIndex((step) => step.uses === 'pnpm/setup@v2')).toBeLessThan(node)
      expect(steps[node].with.cache).toBe('pnpm')
      expect(steps[node].with['cache-dependency-path']).toBe('mobile/pnpm-lock.yaml')
      const install = steps.find((step) => step.name === 'Install dependencies')
      expect(install.if).toBeUndefined()
      expect(install.run).toBe('pnpm install --frozen-lockfile')
      const prebuild = steps.findIndex((step) => step.name === 'Expo prebuild')
      expect(steps[prebuild].if).toBeUndefined()
      expect(prebuild).toBeLessThan(steps.findIndex((step) => step.uses === 'actions/cache@v5'))
    }
  )

  it('caches only Gradle downloads, with generated native and toolchain inputs', () => {
    const steps = workflow('mobile-android-release').jobs['android-build'].steps
    const setup = steps.find((step) => step.uses === 'gradle/actions/setup-gradle@v4')
    expect(setup.with['cache-disabled']).toBe(true)
    const cache = steps.find((step) => step.name === 'Cache Gradle dependency downloads')
    expect(cache.with.path.trim().split('\n')).toEqual([
      '~/.gradle/caches/modules-2',
      '~/.gradle/wrapper/dists'
    ])
    for (const input of [
      'runner.os',
      'runner.arch',
      'jdk17',
      'mobile/pnpm-lock.yaml',
      'mobile/patches/**',
      'mobile/android/**/*.gradle',
      'gradle-wrapper.properties'
    ]) {
      expect(cache.with.key).toContain(input)
    }
    expect(cache.with['restore-keys'].trim()).toBe(
      "gradle-downloads-v1-${{ runner.os }}-${{ runner.arch }}-jdk17-${{ hashFiles('mobile/android/gradle/wrapper/gradle-wrapper.properties') }}-"
    )
    const build = steps.find((step) => step.name === 'Build Android release APK')
    expect(build.if).toBeUndefined()
    expect(build.run).toBe('cd android && ./gradlew assembleRelease')
  })

  it('caches CocoaPods downloads without Pods, signing state, or build products', () => {
    const steps = workflow('mobile-ios-release').jobs['ios-build'].steps
    const cache = steps.find((step) => step.name === 'Cache CocoaPods downloads')
    expect(cache.with.path).toBe('~/Library/Caches/CocoaPods')
    for (const input of [
      'runner.os',
      'runner.arch',
      'xcode26.5',
      'mobile/Gemfile.lock',
      'mobile/pnpm-lock.yaml',
      'mobile/patches/**',
      'mobile/ios/Podfile',
      'Podfile.properties.json'
    ]) {
      expect(cache.with.key).toContain(input)
    }
    expect(cache.with['restore-keys'].trim()).toBe(
      "cocoapods-downloads-v1-${{ runner.os }}-${{ runner.arch }}-xcode26.5-${{ hashFiles('mobile/Gemfile.lock') }}-"
    )
    const install = steps.find((step) => step.name === 'Install CocoaPods')
    expect(install.if).toBeUndefined()
    expect(install.run).toBe('npx pod-install ios')
    expect(steps.indexOf(cache)).toBeLessThan(steps.indexOf(install))
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

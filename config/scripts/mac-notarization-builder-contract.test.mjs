import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { setImmediate } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const builderRequire = createRequire(createRequire(import.meta.url).resolve('electron-builder'))
const require = createRequire(builderRequire.resolve('app-builder-lib'))
// Initialize the package root before submodules to preserve its CJS dependency order.
const { Platform } = require('app-builder-lib')
const { PlatformPackager } = require('app-builder-lib/out/platformPackager')
const { ArchiveTarget } = require('app-builder-lib/out/targets/ArchiveTarget')
const { DmgTarget } = require('dmg-builder/out/dmg')
const { computeArchToTargetNamesMap } = require('app-builder-lib/out/targets/targetFactory')
const { AsyncTaskManager } = require('builder-util')
const { CancellationToken } = require('builder-util-runtime')
const workflow = (name) => parse(readFileSync(`.github/workflows/${name}-mac-build.yml`, 'utf8'))

it('the pinned builder reaches both signed slices before either real archive target passes its gate', async () => {
  let release
  const barrier = new Promise((resolve) => {
    release = resolve
  })
  const events = []
  const packager = {
    platform: Platform.MAC,
    config: {},
    appInfo: { version: '1.0.0' },
    platformSpecificBuildOptions: {},
    info: {
      cancellationToken: new CancellationToken(),
      emitArtifactBuildStarted: async ({ arch }) => {
        events.push(`wait:${arch}`)
        await barrier
        events.push(`pass:${arch}`)
        throw new Error('STOP_BEFORE_ARTIFACT_IO')
      }
    },
    expandArtifactNamePattern: (_options, extension, arch) => `fixture-${arch}.${extension}`
  }
  const archive = new ArchiveTarget('zip', '/unused', packager)
  const targets = [archive, new DmgTarget(packager, '/unused')]
  const manager = new AsyncTaskManager(packager.info.cancellationToken)
  for (const arch of [1, 3]) {
    events.push(`signed:${arch}`)
    PlatformPackager.prototype.packageInDistributableFormat.call(
      packager,
      '/unused.app',
      arch,
      targets,
      manager
    )
    await setImmediate()
  }
  expect(events.filter((event) => event.startsWith('signed:'))).toEqual(['signed:1', 'signed:3'])
  expect(events.filter((event) => event.startsWith('wait:'))).toHaveLength(4)
  expect(events.some((event) => event.startsWith('pass:'))).toBe(false)
  release()
  manager.addTask(archive.finishBuild())
  await expect(manager.awaitTasks()).rejects.toThrow('STOP_BEFORE_ARTIFACT_IO')
  expect(events.filter((event) => event.startsWith('pass:'))).toHaveLength(4)
})

it('explicit archive targets keep the configured dual-architecture defaults out of each matrix job', () => {
  const packager = {
    platformSpecificBuildOptions: {
      target: [
        { target: 'dmg', arch: ['x64', 'arm64'] },
        { target: 'zip', arch: ['x64', 'arm64'] }
      ]
    }
  }
  for (const arch of [1, 3]) {
    const targets = computeArchToTargetNamesMap(
      new Map([[arch, ['dmg', 'zip']]]),
      packager,
      Platform.MAC
    )
    expect([...targets]).toEqual([[arch, ['dmg', 'zip']]])
  }
})

describe('macOS build workflow policy', () => {
  it.each(['release', 'adhoc', 'daily', 'hourly'])(
    '%s uses the guarded builder, preserving the serial fallback for older source refs',
    (channel) => {
      const job = Object.values(workflow(channel).jobs).find((job) =>
        job.steps?.some((step) => step.with?.command?.includes('electron-builder --config'))
      )
      expect(job['runs-on']).toBe(
        { adhoc: 'blacksmith-12vcpu-macos-15', release: 'blacksmith-6vcpu-macos-15' }[channel] ??
          'macos-15'
      )
      const step = job.steps.find((step) =>
        step.with?.command?.includes('electron-builder --config')
      )
      const command = step.with.command
      if (channel === 'adhoc') {
        expect(job.strategy).toEqual({ 'fail-fast': false, matrix: { arch: ['x64', 'arm64'] } })
        expect(command).toContain('--mac dmg zip --${{ matrix.arch }} --publish never')
        expect(command).toContain('ORCA_MAC_ADHOC=1 pnpm exec electron-builder')
        expect(command).not.toContain('build-mac-notarization-overlap.mjs')
      } else {
        expect(command).toContain('if [ -f config/scripts/build-mac-notarization-overlap.mjs ]')
        expect(command).toContain(
          `ORCA_MAC_${channel.toUpperCase()}=1 node config/scripts/build-mac-notarization-overlap.mjs`
        )
        expect(command).toContain(
          `else ORCA_MAC_${channel.toUpperCase()}=1 pnpm exec electron-builder`
        )
      }
      expect(step.with.max_attempts).toBeGreaterThan(1)
      for (const key of [
        'CSC_LINK',
        'CSC_KEY_PASSWORD',
        'APPLE_ID',
        'APPLE_APP_SPECIFIC_PASSWORD',
        'APPLE_TEAM_ID'
      ]) {
        expect(step.env[key]).toContain('secrets.')
      }
    }
  )

  it('qualification signs the workflow commit, gates its complete template, and cannot publish', () => {
    const source = workflow('release')
    expect(source.on.workflow_dispatch.inputs.qualification_only.default).toBe(false)
    expect(source.concurrency).toEqual({
      group:
        "release-mac-build-${{ inputs.tag }}${{ inputs.qualification_only && '-qualification' || '' }}",
      'cancel-in-progress': false
    })
    expect(source.jobs['qualification-template'].if).toBe('inputs.qualification_only')
    expect(source.jobs['qualification-template'].with).toEqual({
      ref: '${{ github.sha }}'
    })
    expect(source.jobs['qualification-template'].uses).toBe(
      './.github/workflows/qualified-orcad-template.yml'
    )
    const job = source.jobs['build-mac']
    expect(job.needs).toBe('qualification-template')
    expect(job.if).toContain('!cancelled()')
    expect(job.if).toContain("needs.qualification-template.result == 'success'")
    const publish = job.steps.find((step) => step.name === 'Publish release artifacts (macOS)')
    expect(publish.env.ORCA_MAC_PUBLISH).toBe(
      "${{ inputs.qualification_only && 'never' || 'always' }}"
    )
    expect(publish.with.command.match(/--publish "\$ORCA_MAC_PUBLISH"/g)).toHaveLength(2)
    for (const name of [
      'Abort if the parent release-cut run was cancelled',
      'Verify release remains draft after artifact upload'
    ]) {
      expect(job.steps.find((step) => step.name === name).if).toBe(
        '${{ !inputs.qualification_only }}'
      )
    }
    const upload = job.steps.find((step) => step.name === 'Upload qualification artifacts')
    expect(upload.if).toBe('inputs.qualification_only')
    expect(upload.with['if-no-files-found']).toBe('error')
  })
})

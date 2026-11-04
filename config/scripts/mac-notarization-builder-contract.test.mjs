import { createRequire } from 'node:module'
import { setImmediate } from 'node:timers/promises'
import { expect, it } from 'vitest'

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

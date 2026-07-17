import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  assertSshRelayRuntimeClosureEntries,
  expectedSshRelayRuntimeClosureEntries,
  verifySshRelayRuntimeClosure
} from './ssh-relay-runtime-closure.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

const watcherPackages = Object.freeze({
  'linux-x64-glibc': '@parcel/watcher-linux-x64-glibc',
  'linux-arm64-glibc': '@parcel/watcher-linux-arm64-glibc',
  'darwin-x64': '@parcel/watcher-darwin-x64',
  'darwin-arm64': '@parcel/watcher-darwin-arm64',
  'win32-x64': '@parcel/watcher-win32-x64',
  'win32-arm64': '@parcel/watcher-win32-arm64'
})

function identity(tuple) {
  return {
    tupleId: tuple,
    nodeVersion: '24.18.0',
    dependencies: { nodePtyVersion: '1.1.0', parcelWatcherVersion: '2.5.6' },
    entries: expectedSshRelayRuntimeClosureEntries(tuple)
  }
}

function packageRecords(tuple) {
  return [
    { name: 'node-pty', version: '1.1.0', main: './lib/index.js', license: 'MIT' },
    { name: '@parcel/watcher', version: '2.5.6', main: 'index.js', license: 'MIT' },
    { name: watcherPackages[tuple], version: '2.5.6', main: 'watcher.node', license: 'MIT' },
    { name: 'detect-libc', version: '2.1.2', main: 'lib/detect-libc.js', license: 'Apache-2.0' },
    { name: 'is-glob', version: '4.0.3', main: 'index.js', license: 'MIT' },
    { name: 'is-extglob', version: '2.1.1', main: 'index.js', license: 'MIT' },
    { name: 'picomatch', version: '4.0.4', main: 'index.js', license: 'MIT' }
  ]
}

async function writeClosureMetadata(tuple = 'linux-x64-glibc') {
  const runtimeRoot = await mkdtemp(join(tmpdir(), 'orca-runtime-closure-'))
  temporaryDirectories.push(runtimeRoot)
  const packages = packageRecords(tuple)
  for (const record of packages) {
    const path = join(runtimeRoot, 'node_modules', ...record.name.split('/'), 'package.json')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`)
  }
  await writeFile(join(runtimeRoot, '.version'), '1.4.140+123456789abc\n')
  await writeFile(
    join(runtimeRoot, 'runtime-metadata.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        tuple,
        nodeVersion: '24.18.0',
        relayBuildVersion: '1.4.140+123456789abc',
        dependencies: { nodePtyVersion: '1.1.0', parcelWatcherVersion: '2.5.6' }
      },
      null,
      2
    )}\n`
  )
  const licenseNames = ['Node.js', ...packages.map((entry) => entry.name)]
  await writeFile(
    join(runtimeRoot, 'THIRD_PARTY_LICENSES.txt'),
    `${licenseNames.map((name) => `===== ${name} =====\n${name} license text\n`).join('\n')}\n`
  )
  return { runtimeRoot, packages }
}

describe('SSH relay runtime exact closure', () => {
  it.each([
    ['linux-x64-glibc', 34],
    ['linux-arm64-glibc', 34],
    ['darwin-x64', 35],
    ['darwin-arm64', 35],
    ['win32-x64', 42],
    ['win32-arm64', 42]
  ])('pins the reviewed %s runtime to %i files and one native watcher', (tuple, fileCount) => {
    const entries = expectedSshRelayRuntimeClosureEntries(tuple)
    const files = entries.filter((entry) => entry.type === 'file')
    expect(files).toHaveLength(fileCount)
    expect(files.filter((entry) => entry.role === 'parcel-watcher-native')).toEqual([
      expect.objectContaining({ path: `node_modules/${watcherPackages[tuple]}/watcher.node` })
    ])
    expect(files.map((entry) => entry.path)).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/(?:^|\/)(?:npm|npx|corepack|pnpm|yarn)(?:\.|\/|$)/i),
        expect.stringMatching(/\.(?:map|pdb|ilk|cc|cpp|c|h|hpp|o|obj)$/i)
      ])
    )
    expect(() => assertSshRelayRuntimeClosureEntries(identity(tuple))).not.toThrow()
  })

  it('rejects undeclared package managers, source maps, and native build outputs', () => {
    const fixture = identity('linux-x64-glibc')
    for (const path of [
      'node_modules/npm/bin/npm-cli.js',
      'relay.js.map',
      'node_modules/node-pty/build/Release/pty.pdb'
    ]) {
      expect(() =>
        assertSshRelayRuntimeClosureEntries({
          ...fixture,
          entries: [
            ...fixture.entries,
            { path, type: 'file', role: 'runtime-javascript', mode: 0o644 }
          ]
        })
      ).toThrow(/undeclared file/i)
    }
  })

  it('rejects a missing native dependency, wrong role, or unreviewed dependency refresh', () => {
    const fixture = identity('darwin-arm64')
    expect(() =>
      assertSshRelayRuntimeClosureEntries({
        ...fixture,
        entries: fixture.entries.filter((entry) => !entry.path.endsWith('/watcher.node'))
      })
    ).toThrow(/missing required file/i)
    expect(() =>
      assertSshRelayRuntimeClosureEntries({
        ...fixture,
        entries: fixture.entries.map((entry) =>
          entry.path === 'bin/node' ? { ...entry, role: 'runtime-javascript' } : entry
        )
      })
    ).toThrow(/unexpected role/i)
    expect(() =>
      assertSshRelayRuntimeClosureEntries({ ...fixture, nodeVersion: '24.19.0' })
    ).toThrow(/dependency versions/i)
  })

  it('verifies exact package metadata, runtime metadata, and non-empty license sections', async () => {
    const fixture = await writeClosureMetadata()
    await expect(
      verifySshRelayRuntimeClosure(fixture.runtimeRoot, identity('linux-x64-glibc'))
    ).resolves.toEqual({ files: 34, packages: 7 })

    const packagePath = join(fixture.runtimeRoot, 'node_modules', 'node-pty', 'package.json')
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
    await writeFile(packagePath, `${JSON.stringify({ ...packageJson, version: '1.1.1' })}\n`)
    await expect(
      verifySshRelayRuntimeClosure(fixture.runtimeRoot, identity('linux-x64-glibc'))
    ).rejects.toThrow(/node-pty/i)
  })

  it('rejects omitted and empty dependency license sections', async () => {
    const fixture = await writeClosureMetadata()
    const licensePath = join(fixture.runtimeRoot, 'THIRD_PARTY_LICENSES.txt')
    const licenseText = await readFile(licensePath, 'utf8')
    await writeFile(licensePath, licenseText.replace(/===== picomatch =====[\s\S]*$/, ''))
    await expect(
      verifySshRelayRuntimeClosure(fixture.runtimeRoot, identity('linux-x64-glibc'))
    ).rejects.toThrow(/license bundle/i)

    const second = await writeClosureMetadata()
    const secondLicensePath = join(second.runtimeRoot, 'THIRD_PARTY_LICENSES.txt')
    const secondText = await readFile(secondLicensePath, 'utf8')
    await writeFile(
      secondLicensePath,
      secondText.replace('===== picomatch =====\npicomatch license text', '===== picomatch =====')
    )
    await expect(
      verifySshRelayRuntimeClosure(second.runtimeRoot, identity('linux-x64-glibc'))
    ).rejects.toThrow(/empty section/i)
  })
})

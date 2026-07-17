import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { assembleSshRelayRuntimeTree } from './ssh-relay-runtime-tree.mjs'

const temporaryDirectories = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

async function writeFixture(path, bytes = path) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
}

async function createWindowsNodePtyBuild(root) {
  const platformFiles = [
    'conpty_console_list_agent.js',
    'eventEmitter2.js',
    'index.js',
    'terminal.js',
    'utils.js',
    'windowsConoutConnection.js',
    'windowsPtyAgent.js',
    'windowsTerminal.js',
    'shared/conout.js',
    'worker/conoutSocketWorker.js'
  ]
  await Promise.all(
    platformFiles.map((path) =>
      writeFixture(join(root, 'lib', ...path.split('/')), `'use strict'\n`)
    )
  )
  await Promise.all(
    ['conpty.node', 'conpty_console_list.node', 'pty.node'].map((name) =>
      writeFixture(join(root, 'build', 'Release', name), name)
    )
  )
  await Promise.all(
    ['conpty.dll', 'OpenConsole.exe'].map((name) =>
      writeFixture(join(root, 'build', 'Release', 'conpty', name), name)
    )
  )
}

describe('SSH relay Windows runtime tree', () => {
  it.each([
    ['win32-x64', 19045],
    ['win32-arm64', 26100]
  ])('carries the %s ConPTY closure and reviewed build floor', async (tuple, minimumBuild) => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-runtime-windows-tree-'))
    temporaryDirectories.push(directory)
    const nodeRoot = join(directory, 'node')
    const nodePtyBuildDirectory = join(directory, 'node-pty')
    const relayDirectory = join(directory, 'relay')
    const runtimeRoot = join(directory, 'runtime')
    const relayBytes = 'relay bytes'
    const watcherBytes = 'watcher bytes'
    const relayHash = createHash('sha256')
      .update(relayBytes)
      .update(watcherBytes)
      .digest('hex')
      .slice(0, 12)
    await Promise.all([
      writeFixture(join(nodeRoot, 'node.exe'), 'node executable'),
      writeFixture(join(nodeRoot, 'LICENSE'), 'Node license'),
      writeFixture(join(relayDirectory, 'relay.js'), relayBytes),
      writeFixture(join(relayDirectory, 'relay-watcher.js'), watcherBytes),
      writeFixture(join(relayDirectory, '.version'), `fixture+${relayHash}\n`),
      createWindowsNodePtyBuild(nodePtyBuildDirectory)
    ])

    const identity = await assembleSshRelayRuntimeTree({
      tuple,
      nodeRoot,
      nodePtyBuildDirectory,
      relayDirectory,
      runtimeRoot,
      nodeVersion: '24.18.0'
    })

    expect(identity.compatibility.minimumBuild).toBe(minimumBuild)

    for (const name of ['conpty.dll', 'OpenConsole.exe']) {
      const path = `node_modules/node-pty/build/Release/conpty/${name}`
      expect(identity.entries).toContainEqual(
        expect.objectContaining({ path, type: 'file', role: 'native-runtime', mode: 0o755 })
      )
      expect(await readFile(join(runtimeRoot, ...path.split('/')), 'utf8')).toBe(name)
    }
    expect(identity.entries.some((entry) => entry.path.endsWith('/pty.node'))).toBe(false)
  })
})

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcessSync } from '../../shared/child-process/run-process'
import { NODE_RUNTIME_ASSETS, type ServerTarget } from '../../shared/node-runtime-pin'
import { ORCAD_NODE_RUNTIME_MARKER_FILENAME } from '../../shared/orcad-artifacts'
import {
  installNodeRuntimeFromHostArchiveCommand,
  nodeRuntimeStoreDir,
  parseRemoteRuntimeExitReport,
  probeRemoteNodeRuntimeCommand,
  promoteRemoteNodeRuntimeCommand,
  remoteNodeRuntimeDir,
  REMOTE_NODE_RUNTIME_MISSING,
  REMOTE_NODE_RUNTIME_READY
} from './orcad-remote-node-runtime'
import { orcadNodeSlotRuntimeCommand } from './orcad-remote-runtime'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function sh(command: string, ...args: string[]): string {
  const result = runProcessSync({
    program: '/bin/sh',
    args: ['-c', command, '--', ...args],
    timeoutMs: 60_000
  })
  if (result.code !== 0) {
    throw new Error(`exit ${result.code}: ${result.stdout}${result.stderr}`)
  }
  return result.stdout.trim()
}

function hostTarget(): ServerTarget | null {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  }
  return null
}

const target = hostTarget()
const archive = target
  ? [process.env.ORCA_NODE_RUNTIME_CACHE_DIR, resolve('out/node-runtime-cache')]
      .filter((dir): dir is string => !!dir)
      .map((dir) => join(dir, NODE_RUNTIME_ASSETS[target].archive))
      .find((path) => existsSync(path))
  : undefined

describe.skipIf(process.platform === 'win32')('remote pinned-Node runtime store', () => {
  it('names the runtime the slot selector resolves, beside the version directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'orcad-runtime-store-'))
    directories.push(root)
    const host = getRemoteHostPlatform('linux-x64')
    const slotDir = join(root, 'orcad-0.1.0+aaaaaaaaaaaa')
    const target = 'linux-x64-glibc'
    const sha = NODE_RUNTIME_ASSETS[target].executableSha256
    mkdirSync(slotDir)
    writeFileSync(join(slotDir, ORCAD_NODE_RUNTIME_MARKER_FILENAME), `${sha}\n`)
    const runtimeDir = remoteNodeRuntimeDir(host, slotDir, target)
    expect(runtimeDir).toBe(join(root, 'runtimes', `node-${sha}`))
    mkdirSync(join(runtimeDir, 'bin'), { recursive: true })
    writeFileSync(join(runtimeDir, 'bin', 'node'), '#!/bin/sh\n', { mode: 0o755 })
    expect(sh(`${orcadNodeSlotRuntimeCommand(host, slotDir)}echo "$orcad_runtime"`)).toBe(
      join(runtimeDir, 'bin', 'node')
    )
  })

  it('splits the runtime exit status from the loader output it reported', () => {
    expect(
      parseRemoteRuntimeExitReport(
        'ORCA_NODE_RUNTIME_SELFTEST_FAILED\nORCA_RUNTIME_EXIT=126\nsh: node: Permission denied\n'
      )
    ).toEqual({ exitStatus: 126, output: 'sh: node: Permission denied' })
    expect(parseRemoteRuntimeExitReport('no report')).toEqual({
      exitStatus: null,
      output: 'no report'
    })
  })

  it('reports a runtime whose bytes do not hash to the pin as missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'orcad-runtime-store-'))
    directories.push(root)
    const host = getRemoteHostPlatform('linux-x64')
    const runtimeDir = join(root, 'runtimes', 'node-x')
    mkdirSync(join(runtimeDir, 'bin'), { recursive: true })
    writeFileSync(join(runtimeDir, 'bin', 'node'), 'tampered', { mode: 0o755 })
    writeFileSync(join(runtimeDir, '.verified'), '')
    expect(sh(probeRemoteNodeRuntimeCommand(host, runtimeDir, 'linux-x64-glibc'))).toBe(
      REMOTE_NODE_RUNTIME_MISSING
    )
  })

  it.skipIf(!archive)(
    'extracts, verifies, self-tests and publishes the official archive on the host',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'orcad-runtime-store-'))
      directories.push(root)
      const host = getRemoteHostPlatform(target === 'darwin-arm64' ? 'darwin-arm64' : 'darwin-x64')
      const slotDir = join(root, 'orcad-0.1.0+bbbbbbbbbbbb')
      const runtimeDir = remoteNodeRuntimeDir(host, slotDir, target!)
      const probe = probeRemoteNodeRuntimeCommand(host, runtimeDir, target!)
      expect(sh(probe)).toBe(REMOTE_NODE_RUNTIME_MISSING)

      const stageDir = join(root, 'runtimes', '.stage-test')
      mkdirSync(stageDir, { recursive: true })
      const archiveName = NODE_RUNTIME_ASSETS[target!].archive
      copyFileSync(archive!, join(stageDir, archiveName))
      const promote = promoteRemoteNodeRuntimeCommand(host, {
        stageDir,
        archive: archiveName,
        runtimeDir,
        target: target!,
        token: 'test'
      })
      expect(sh(promote).split('\n').at(-1)).toBe(REMOTE_NODE_RUNTIME_READY)
      expect(sh(probe)).toBe(REMOTE_NODE_RUNTIME_READY)
      // A second installer of the same pin republishes identical bytes without a torn window.
      expect(sh(promote).split('\n').at(-1)).toBe(REMOTE_NODE_RUNTIME_READY)
      expect(sh(probe)).toBe(REMOTE_NODE_RUNTIME_READY)
    },
    60_000
  )

  it('removes its stage and publishes nothing when a host-readable archive fails verification', () => {
    const root = mkdtempSync(join(tmpdir(), 'orcad-runtime-store-'))
    directories.push(root)
    const host = getRemoteHostPlatform('linux-x64')
    const runtimeDir = nodeRuntimeStoreDir(host, root, 'linux-x64-glibc')
    const source = join(root, 'not-node.tar.gz')
    writeFileSync(source, 'not an archive')
    const install = installNodeRuntimeFromHostArchiveCommand(host, {
      runtimeDir,
      archive: 'node.tar.gz',
      target: 'linux-x64-glibc',
      token: 'test'
    })
    expect(() => sh(install, source)).toThrow('ORCA_NODE_RUNTIME_EXTRACT_FAILED')
    expect(readdirSync(join(root, 'runtimes'))).toEqual([])
  })

  it.skipIf(!archive)(
    'installs from a host-readable archive into the store the probe accepts',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'orcad-runtime-store-'))
      directories.push(root)
      const host = getRemoteHostPlatform(target === 'darwin-arm64' ? 'darwin-arm64' : 'darwin-x64')
      const runtimeDir = nodeRuntimeStoreDir(host, root, target!)
      const install = installNodeRuntimeFromHostArchiveCommand(host, {
        runtimeDir,
        archive: NODE_RUNTIME_ASSETS[target!].archive,
        target: target!,
        token: 'test'
      })
      expect(sh(install, archive!).split('\n').at(-1)).toBe(REMOTE_NODE_RUNTIME_READY)
      expect(sh(probeRemoteNodeRuntimeCommand(host, runtimeDir, target!))).toBe(
        REMOTE_NODE_RUNTIME_READY
      )
      expect(readdirSync(join(root, 'runtimes'))).toEqual([
        `node-${NODE_RUNTIME_ASSETS[target!].executableSha256}`
      ])
    },
    60_000
  )
})

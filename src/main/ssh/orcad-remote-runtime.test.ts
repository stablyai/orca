import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcessSync } from '../../shared/child-process/run-process'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { selectOrcadSlotRuntimeCommand } from './orcad-remote-runtime'
import { stopOrcadCommand } from './orcad-remote-process-control'
import { shellEscape } from './ssh-connection-utils'

const directories: string[] = []
const host = getRemoteHostPlatform('linux-x64')

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "orca 'quoted' $slot-"))
  directories.push(directory)
  return directory
}

const NODE_SHA = 'e4b5a3af0e05c75de2eae013904145f40fe7fc2a6e6f17510128bf45cca4e79b'

/** A slot beside the shared `runtimes/` dir, as installed under `~/.orca-remote`. */
function nodeSlot(options: { marker?: string; runtime?: boolean } = {}): string {
  const root = fixture()
  const slot = join(root, 'orcad-0.1.0-abcdef')
  mkdirSync(slot)
  writeFileSync(join(slot, '.runtime-node'), options.marker ?? `${NODE_SHA}\n`)
  if (options.runtime !== false) {
    const binDir = join(root, 'runtimes', `node-${NODE_SHA}`, 'bin')
    mkdirSync(binDir, { recursive: true })
    symlinkSync(process.execPath, join(binDir, 'node'))
  }
  return slot
}

/** Frozen copy of the Bun-era selector that shipped clients still run (design D7.1 R5). */
function bunEraSelectorCommand(directory: string, legacyNodePath: string): string {
  const runtime = shellEscape(join(directory, 'bun-runtime'))
  const target = shellEscape(join(directory, '.build-target'))
  return (
    `if [ -e ${target} ] || [ -e ${runtime} ]; then ` +
    `[ -x ${runtime} ] || exit 78; orcad_runtime=${runtime}; ` +
    `else orcad_runtime=${shellEscape(legacyNodePath)}; fi`
  )
}

function runSelected(selector: string) {
  return runProcessSync({
    program: '/bin/sh',
    args: ['-c', `${selector}; "$orcad_runtime" -e 'process.stdout.write("selected")'`]
  })
}

function launch(directory: string, nodePath: string) {
  return runSelected(selectOrcadSlotRuntimeCommand(host, directory, nodePath))
}

describe.skipIf(process.platform === 'win32')('POSIX slot runtime selection', () => {
  it('returns an unverifiable stop result when a bundled runtime cannot execute', () => {
    const directory = fixture()
    writeFileSync(join(directory, '.build-target'), 'linux-x64-glibc')
    writeFileSync(join(directory, '.orcad-pid'), String(process.pid))
    const result = runProcessSync({
      program: '/bin/sh',
      args: [
        '-c',
        stopOrcadCommand(host, directory, { waitSeconds: 1, nodePath: process.execPath })
      ]
    })
    expect(result).toMatchObject({ code: 0, stdout: 'UNKNOWN\n' })
  })

  it('uses the bundled executable when host Node does not exist', () => {
    const directory = fixture()
    writeFileSync(join(directory, '.build-target'), 'linux-x64-glibc')
    symlinkSync(process.execPath, join(directory, 'bun-runtime'))
    expect(launch(directory, '/missing-host-node')).toMatchObject({ code: 0, stdout: 'selected' })
  })

  it('refuses an incomplete Bun slot before invoking a working host Node', () => {
    const directory = fixture()
    writeFileSync(join(directory, '.build-target'), 'linux-x64-glibc')
    expect(launch(directory, process.execPath)).toMatchObject({ code: 78, stdout: '' })
  })

  it('retains the original runtime for a legacy slot', () => {
    expect(launch(fixture(), process.execPath)).toMatchObject({ code: 0, stdout: 'selected' })
  })

  it('launches a Node slot from its shared pinned runtime, never host Node', () => {
    expect(launch(nodeSlot(), '/missing-host-node')).toMatchObject({ code: 0, stdout: 'selected' })
  })

  it('accepts a Node slot path with a trailing separator', () => {
    expect(launch(`${nodeSlot()}/`, '/missing-host-node')).toMatchObject({
      code: 0,
      stdout: 'selected'
    })
  })

  it('refuses a Node slot whose pinned runtime is missing before invoking a working host Node', () => {
    expect(launch(nodeSlot({ runtime: false }), process.execPath)).toMatchObject({
      code: 78,
      stdout: ''
    })
  })

  it.each([
    ['empty', ''],
    ['short', 'abc123'],
    ['uppercase', NODE_SHA.toUpperCase()],
    ['path traversal', `../${NODE_SHA.slice(3)}`]
  ])('refuses a Node slot with a %s marker', (_label, marker) => {
    expect(launch(nodeSlot({ marker }), process.execPath)).toMatchObject({ code: 78, stdout: '' })
  })

  it('prefers the Node marker over Bun files in the same slot', () => {
    const slot = nodeSlot()
    writeFileSync(join(slot, '.build-target'), 'linux-x64-glibc')
    expect(launch(slot, '/missing-host-node')).toMatchObject({ code: 0, stdout: 'selected' })
  })

  it('shows a Node slot to a Bun-era client as legacy, not as a broken Bun slot', () => {
    const slot = nodeSlot()
    expect(runSelected(bunEraSelectorCommand(slot, process.execPath))).toMatchObject({
      code: 0,
      stdout: 'selected'
    })
  })

  it('keeps the frozen Bun-era selector in step with the current Bun and legacy branches', () => {
    const bun = fixture()
    writeFileSync(join(bun, '.build-target'), 'linux-x64-glibc')
    expect(runSelected(bunEraSelectorCommand(bun, process.execPath)).code).toBe(78)
    expect(launch(bun, process.execPath).code).toBe(78)
    const legacy = fixture()
    expect(runSelected(bunEraSelectorCommand(legacy, process.execPath)).stdout).toBe('selected')
    expect(launch(legacy, process.execPath).stdout).toBe('selected')
  })

  it('reads a stop verdict from a Node slot through its pinned runtime', () => {
    const slot = nodeSlot()
    writeFileSync(join(slot, '.orcad-pid'), String(process.pid))
    const result = runProcessSync({
      program: '/bin/sh',
      args: ['-c', stopOrcadCommand(host, slot, { waitSeconds: 1, nodePath: '/missing-host-node' })]
    })
    // No readiness file: the pinned runtime ran and reported no PID, so the verdict is unverifiable.
    expect(result).toMatchObject({ code: 0, stdout: 'UNKNOWN\n' })
  })
})

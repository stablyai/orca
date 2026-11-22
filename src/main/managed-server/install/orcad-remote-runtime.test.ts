import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import { getRemoteHostPlatform } from '../../ssh/remote-host/ssh-remote-platform'
import { selectOrcadSlotRuntimeCommand } from './orcad-remote-runtime'

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

/** Frozen Bun-era selector still used by shipped clients. */

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
  it('launches a Node slot from its shared pinned runtime, never host Node', () => {
    expect(launch(nodeSlot(), '/missing-host-node')).toMatchObject({ code: 0, stdout: 'selected' })
  })

  it('refuses a Node slot whose pinned runtime is missing before invoking a working host Node', () => {
    expect(launch(nodeSlot({ runtime: false }), process.execPath)).toMatchObject({
      code: 78,
      stdout: ''
    })
  })

  it.each([
    ['short', 'abc123'],
    ['path traversal', `../${NODE_SHA.slice(3)}`]
  ])('refuses a Node slot with a %s marker', (_label, marker) => {
    expect(launch(nodeSlot({ marker }), process.execPath)).toMatchObject({ code: 78, stdout: '' })
  })
})

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcessSync } from '../../shared/child-process/run-process'
import { getRemoteHostPlatform } from './ssh-remote-platform'
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

function launch(directory: string, nodePath: string) {
  return runProcessSync({
    program: '/bin/sh',
    args: [
      '-c',
      `${selectOrcadSlotRuntimeCommand(host, directory, nodePath)}; ` +
        '"$orcad_runtime" -e \'process.stdout.write("selected")\''
    ]
  })
}

describe.skipIf(process.platform === 'win32')('POSIX slot runtime selection', () => {
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
})

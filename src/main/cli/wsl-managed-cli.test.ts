import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getManagedWslCliDir } from './wsl-managed-cli'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-managed-wsl-'))
  roots.push(root)
  const resourcesPath = join(root, 'resources with spaces')
  mkdirSync(join(resourcesPath, 'bin'), { recursive: true })
  writeFileSync(join(resourcesPath, 'bin', 'orca.exe'), 'fixture')
  return { isPackaged: true, resourcesPath, userDataPath: join(root, 'user data') }
}

describe('managed WSL CLI provisioning', () => {
  it('reuses a complete tree, repairs missing files, and isolates app identities and updates', () => {
    const host = fixture()
    const directory = getManagedWslCliDir(host) ?? ''
    const launcher = join(directory, 'orca-ide')
    const modified = statSync(launcher).mtimeMs
    expect(getManagedWslCliDir(host)).toBe(directory)
    expect(statSync(launcher).mtimeMs).toBe(modified)
    rmSync(launcher)
    expect(getManagedWslCliDir(host)).toBe(directory)
    expect(readFileSync(launcher, 'utf8')).toContain('resources with spaces')
    const second = { ...host, userDataPath: join(host.userDataPath, 'second') }
    expect(getManagedWslCliDir(second)).not.toBe(directory)
    const update = fixture()
    expect(getManagedWslCliDir({ ...update, userDataPath: host.userDataPath })).not.toBe(directory)
  })

  it('provides nothing when user data cannot hold the CLI', () => {
    const host = fixture()
    writeFileSync(host.userDataPath, 'a file, not a directory')
    expect(getManagedWslCliDir(host)).toBeNull()
  })
})

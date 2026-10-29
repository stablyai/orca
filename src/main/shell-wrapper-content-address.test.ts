import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import {
  resolveShellWrapperRoot,
  type ShellWrapperFileBuilder
} from './shell-wrapper-content-address'
import { writeShellWrapperFiles } from './shell-wrapper-file-writer'

function builderFor(marker: string): ShellWrapperFileBuilder {
  // Model the embedded root in .zshenv to verify stable hashing.
  return (root) => [
    [join(root, 'zsh', '.zshrc'), `zshrc ${marker} root=${root}`],
    [join(root, 'bash', 'rcfile'), `rcfile ${marker}`]
  ]
}

function makeBase(): string {
  return mkdtempSync(join(tmpdir(), 'orca-wrapper-address-'))
}

describe('resolveShellWrapperRoot', () => {
  it('gives builds with different wrapper contents different trees', () => {
    const base = makeBase()
    expect(resolveShellWrapperRoot(base, builderFor('ORCA_SHELL_READY_MARKER'))).not.toEqual(
      resolveShellWrapperRoot(base, builderFor('ORCA_SHELL_FEATURES'))
    )
  })

  it('is stable for identical contents', () => {
    const base = makeBase()
    expect(resolveShellWrapperRoot(base, builderFor('a'))).toEqual(
      resolveShellWrapperRoot(base, builderFor('a'))
    )
  })

  it('keeps the zsh dir ending in /shell-ready/zsh', () => {
    const root = resolveShellWrapperRoot(makeBase(), builderFor('a'))
    // Shell guards match a POSIX suffix on every host.
    expect(join(root, 'zsh').split(sep).join('/').endsWith('/shell-ready/zsh')).toBe(true)
  })

  it('lets two contracts coexist instead of clobbering each other', () => {
    const base = makeBase()
    const oldBuild = builderFor('old')
    const newBuild = builderFor('new')
    const oldRoot = resolveShellWrapperRoot(base, oldBuild)
    const newRoot = resolveShellWrapperRoot(base, newBuild)

    writeShellWrapperFiles(oldBuild(oldRoot), '[test]')
    writeShellWrapperFiles(newBuild(newRoot), '[test]')

    expect(readFileSync(join(oldRoot, 'bash', 'rcfile'), 'utf8')).toBe('rcfile old')
    expect(readFileSync(join(newRoot, 'bash', 'rcfile'), 'utf8')).toBe('rcfile new')
  })

  it('never resolves onto the legacy unversioned tree', () => {
    const userData = makeBase()
    const root = resolveShellWrapperRoot(join(userData, 'shell-wrappers'), builderFor('a'))
    expect(root.startsWith(join(userData, 'shell-wrappers') + sep)).toBe(true)
    expect(root).not.toEqual(join(userData, 'shell-ready'))
  })
})

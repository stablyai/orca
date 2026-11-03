import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
})

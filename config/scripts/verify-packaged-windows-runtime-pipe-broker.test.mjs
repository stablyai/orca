import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import verifier from './verify-packaged-windows-runtime-pipe-broker.cjs'

const { verifyPackagedWindowsRuntimePipeBroker } = verifier

describe('verifyPackagedWindowsRuntimePipeBroker', () => {
  it('reads the copied binary back and compares its hash', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-broker-package-'))
    const source = join(root, 'source.exe')
    const resources = join(root, 'resources')
    const packaged = join(resources, 'bin', 'orca-pipe-broker.exe')
    mkdirSync(join(resources, 'bin'), { recursive: true })
    writeFileSync(source, 'broker-binary')
    copyFileSync(source, packaged)
    const result = verifyPackagedWindowsRuntimePipeBroker(resources, {
      sourcePath: source,
      execute: false
    })
    assert.equal(result.packagedHash, result.sourceHash)
  })

  it('rejects a package whose copied binary differs', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-broker-package-'))
    const source = join(root, 'source.exe')
    const resources = join(root, 'resources')
    mkdirSync(join(resources, 'bin'), { recursive: true })
    writeFileSync(source, 'expected')
    writeFileSync(join(resources, 'bin', 'orca-pipe-broker.exe'), 'tampered')
    assert.throws(() =>
      verifyPackagedWindowsRuntimePipeBroker(resources, {
        sourcePath: source,
        execute: false
      }),
    /hash mismatch/)
  })

  it('reads back and executes the real packaged-copy fixture', { skip: process.platform !== 'win32' }, () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-broker-package-'))
    const resources = join(root, 'resources')
    const packaged = join(resources, 'bin', 'orca-pipe-broker.exe')
    const source = resolve(
      'native',
      'windows-runtime-pipe-broker',
      '.build',
      'orca-pipe-broker.exe'
    )
    mkdirSync(join(resources, 'bin'), { recursive: true })
    copyFileSync(source, packaged)
    const result = verifyPackagedWindowsRuntimePipeBroker(resources, { sourcePath: source })
    assert.equal(result.packagedHash, result.sourceHash)
  })
})

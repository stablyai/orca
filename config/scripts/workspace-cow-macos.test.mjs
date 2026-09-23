import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

describe.skipIf(process.platform !== 'darwin')('native APFS materialization', () => {
  let buildRoot, helper, root, source, staged, target
  const run = (command, from, to) => spawnSync(helper, [command, from, to], { encoding: 'utf8' })
  beforeAll(() => {
    buildRoot = mkdtempSync(join(tmpdir(), 'orca-cow-native-build-'))
    helper = join(buildRoot, 'orca-workspace-cow')
    execFileSync(process.execPath, [
      resolve('config/scripts/build-workspace-cow-macos.mjs'),
      '--single-arch',
      '--output',
      helper
    ])
  })
  afterAll(() => rmSync(buildRoot, { recursive: true, force: true }))
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-cow-native-test-'))
    source = join(root, 'source')
    staged = join(root, 'staged')
    target = join(root, 'target')
    mkdirSync(source)
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('clones a private tree, preserves symlinks and mode, and publishes it', () => {
    mkdirSync(join(source, 'nested'))
    writeFileSync(join(source, 'nested', 'data'), 'original')
    chmodSync(join(source, 'nested', 'data'), 0o640)
    symlinkSync('nested/data', join(source, 'entry'))
    symlinkSync('missing', join(source, 'broken'))
    expect(run('probe', source, root).status).toBe(0)
    expect(run('clone', `${source}/`, staged).status).toBe(0)
    expect(run('publish', staged, target).status).toBe(0)
    expect(existsSync(staged)).toBe(false)
    expect(readlinkSync(join(target, 'entry'))).toBe('nested/data')
    expect(readlinkSync(join(target, 'broken'))).toBe('missing')
    expect(statSync(join(target, 'nested', 'data')).mode & 0o777).toBe(0o640)
    writeFileSync(join(target, 'nested', 'data'), 'changed')
    expect(readFileSync(join(source, 'nested', 'data'), 'utf8')).toBe('original')
  })

  it.each(['file', 'directory', 'symlink'])('preserves a raced %s at publication', (kind) => {
    writeFileSync(join(source, 'data'), 'source')
    expect(run('clone', source, staged).status).toBe(0)
    if (kind === 'file') {
      writeFileSync(target, 'mine')
    }
    if (kind === 'directory') {
      mkdirSync(target)
    }
    if (kind === 'symlink') {
      symlinkSync('missing', target)
    }
    const result = run('publish', staged, target)
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stderr)).toEqual({ errno: 17 })
    expect(readFileSync(join(staged, 'data'), 'utf8')).toBe('source')
    if (kind === 'file') {
      expect(readFileSync(target, 'utf8')).toBe('mine')
    }
    if (kind === 'directory') {
      expect(readdirSync(target)).toEqual([])
    }
    if (kind === 'symlink') {
      expect(lstatSync(target).isSymbolicLink()).toBe(true)
    }
  })

  it('rejects a special file without waiting for a writer', () => {
    execFileSync('/usr/bin/mkfifo', [join(source, 'pipe')])
    const result = run('clone', source, staged)
    expect(result.status).toBe(1)
    expect(JSON.parse(result.stderr).errno).toBe(45)
    expect(existsSync(target)).toBe(false)
  })

  it('clones an individual file without sharing its inode', () => {
    const file = join(source, 'data')
    writeFileSync(file, 'original')
    expect(run('clone', file, staged).status).toBe(0)
    expect(statSync(staged).ino).not.toBe(statSync(file).ino)
    writeFileSync(staged, 'changed')
    expect(readFileSync(file, 'utf8')).toBe('original')
  })
})

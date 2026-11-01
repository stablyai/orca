import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listPackage, statFile } from '@electron/asar'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createPublishTransaction,
  publishFile,
  publishStagedResources,
  replaceDirectory,
  repackExtractedApp,
  stageFilteredOut
} from './sync-win-unpacked.mjs'

describe('sync-win-unpacked directory replace', () => {
  let root

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function writeTree(dir, contents) {
    mkdirSync(dir, { recursive: true })
    for (const [name, text] of Object.entries(contents)) {
      writeFileSync(join(dir, name), text)
    }
  }

  it('swaps in a staged copy and removes the backup', () => {
    root = mkdtempSync(join(tmpdir(), 'sync-win-unpacked-'))
    const dest = join(root, 'main')
    const source = join(root, 'source')
    writeTree(dest, { 'marker.txt': 'old' })
    writeTree(source, { 'marker.txt': 'new' })

    replaceDirectory(dest, source)

    expect(readFileSync(join(dest, 'marker.txt'), 'utf8')).toBe('new')
    expect(existsSync(`${dest}.bak`)).toBe(false)
    expect(existsSync(`${dest}.new`)).toBe(false)
  })

  it('leaves the destination in place when the staged copy fails', () => {
    root = mkdtempSync(join(tmpdir(), 'sync-win-unpacked-'))
    const dest = join(root, 'main')
    writeTree(dest, { 'marker.txt': 'old' })

    expect(() => replaceDirectory(dest, join(root, 'missing'))).toThrow()
    expect(readFileSync(join(dest, 'marker.txt'), 'utf8')).toBe('old')
    expect(existsSync(`${dest}.bak`)).toBe(false)
    expect(existsSync(`${dest}.new`)).toBe(false)
  })

  it('rolls back every replacement when a later copy fails', () => {
    root = mkdtempSync(join(tmpdir(), 'sync-win-unpacked-'))
    const dest = join(root, 'main')
    const source = join(root, 'source')
    const asar = join(root, 'app.asar')
    const asarNext = join(root, 'app.asar.next')
    writeTree(dest, { 'marker.txt': 'old' })
    writeTree(source, { 'marker.txt': 'new' })
    writeFileSync(asar, 'old-asar')
    writeFileSync(asarNext, 'new-asar')
    const transaction = createPublishTransaction()

    expect(() => {
      publishFile(transaction, asarNext, asar)
      replaceDirectory(dest, source, transaction)
      replaceDirectory(join(root, 'cli'), join(root, 'missing'), transaction)
      transaction.commit()
    }).toThrow()
    transaction.rollback()

    expect(readFileSync(asar, 'utf8')).toBe('old-asar')
    expect(readFileSync(join(dest, 'marker.txt'), 'utf8')).toBe('old')
    expect(existsSync(`${dest}.bak`)).toBe(false)
    expect(existsSync(`${dest}.new`)).toBe(false)
    expect(existsSync(`${asar}.bak`)).toBe(false)
    expect(existsSync(`${asar}.new`)).toBe(false)
  })

  it('keeps a leftover backup when replacing a directory again', () => {
    root = mkdtempSync(join(tmpdir(), 'sync-win-unpacked-'))
    const dest = join(root, 'main')
    const backup = `${dest}.bak`
    mkdirSync(backup, { recursive: true })
    writeFileSync(join(backup, 'marker.txt'), 'saved')

    expect(() => replaceDirectory(dest, join(root, 'missing'))).toThrow()
    expect(readFileSync(join(dest, 'marker.txt'), 'utf8')).toBe('saved')
    expect(existsSync(backup)).toBe(false)

    const occupied = join(root, 'occupied')
    const occupiedBackup = `${occupied}.bak`
    writeTree(occupied, { 'marker.txt': 'current' })
    writeTree(occupiedBackup, { 'marker.txt': 'saved' })
    writeTree(join(root, 'source'), { 'marker.txt': 'new' })
    expect(() => replaceDirectory(occupied, join(root, 'source'))).toThrow(
      `[sync-win-unpacked] leftover backup exists at ${occupiedBackup}; restore or remove it before syncing`
    )
    expect(readFileSync(join(occupied, 'marker.txt'), 'utf8')).toBe('current')
    expect(readFileSync(join(occupiedBackup, 'marker.txt'), 'utf8')).toBe('saved')
    expect(existsSync(`${occupied}.new`)).toBe(false)
  })

  it('drops backups only after the transaction commits', () => {
    root = mkdtempSync(join(tmpdir(), 'sync-win-unpacked-'))
    const dest = join(root, 'main')
    const source = join(root, 'source')
    writeTree(dest, { 'marker.txt': 'old' })
    writeTree(source, { 'marker.txt': 'new' })
    const transaction = createPublishTransaction()

    replaceDirectory(dest, source, transaction)
    expect(existsSync(`${dest}.bak`)).toBe(true)
    transaction.commit()

    expect(readFileSync(join(dest, 'marker.txt'), 'utf8')).toBe('new')
    expect(existsSync(`${dest}.bak`)).toBe(false)
  })

  it('reports a restore failure and still rolls back earlier replacements', () => {
    root = mkdtempSync(join(tmpdir(), 'sync-win-unpacked-'))
    const kept = join(root, 'kept')
    const keptBackup = join(root, 'kept.bak')
    writeFileSync(kept, 'new')
    writeFileSync(keptBackup, 'old')
    const brokenDest = join(root, 'missing-parent', 'dest')
    const brokenBackup = join(root, 'broken.bak')
    writeFileSync(brokenBackup, 'backup')
    const errors = []
    const originalError = console.error
    console.error = (...args) => {
      errors.push(args.join(' '))
    }
    const transaction = createPublishTransaction()
    transaction.retain(kept, keptBackup)
    transaction.retain(brokenDest, brokenBackup)
    try {
      transaction.rollback()
    } finally {
      console.error = originalError
    }

    expect(readFileSync(kept, 'utf8')).toBe('old')
    expect(existsSync(brokenBackup)).toBe(true)
    expect(errors.some((line) => line.includes(`rollback failed for ${brokenDest}`))).toBe(true)
    expect(
      errors.some((line) => line.includes(`previous contents may remain at ${brokenBackup}`))
    ).toBe(true)
  })

  it('publishes the unpacked tree from asarUnpack next to synced out files', async () => {
    root = mkdtempSync(join(tmpdir(), 'sync-win-unpacked-'))
    const source = join(root, 'src')
    mkdirSync(join(source, 'out', 'main'), { recursive: true })
    mkdirSync(join(source, 'out', 'web'), { recursive: true })
    mkdirSync(join(source, 'resources', 'nested'), { recursive: true })
    mkdirSync(join(source, 'packed'), { recursive: true })
    writeFileSync(join(source, 'out', 'main', 'daemon-entry.js'), 'daemon\n')
    writeFileSync(join(source, 'out', 'web', 'app.js'), 'web\n')
    writeFileSync(join(source, 'resources', 'nested', 'keep.txt'), 'keep\n')
    writeFileSync(join(source, 'packed', 'only.txt'), 'packed\n')

    const staging = join(root, 'stage')
    mkdirSync(staging, { recursive: true })
    await repackExtractedApp(source, join(staging, 'app.asar'))
    const syncedWeb = join(staging, 'app.asar.unpacked', 'out', 'web')
    mkdirSync(syncedWeb, { recursive: true })
    writeFileSync(join(syncedWeb, 'app.js'), 'web\n')
    const host = join(staging, 'node_modules', '@orca', 'process-host')
    mkdirSync(join(host, 'dist'), { recursive: true })
    writeFileSync(join(host, 'package.json'), '{}\n')
    writeFileSync(join(host, 'dist', 'index.js'), '')

    const resources = join(root, 'resources')
    mkdirSync(resources, { recursive: true })
    writeFileSync(join(resources, 'app.asar'), 'old-asar')
    const transaction = createPublishTransaction()
    publishStagedResources(transaction, staging, resources)
    transaction.commit()

    const unpacked = join(resources, 'app.asar.unpacked')
    const destAsar = join(resources, 'app.asar')
    expect(readFileSync(join(unpacked, 'resources', 'nested', 'keep.txt'), 'utf8')).toBe('keep\n')
    expect(readFileSync(join(unpacked, 'out', 'main', 'daemon-entry.js'), 'utf8')).toBe('daemon\n')
    expect(readFileSync(join(unpacked, 'out', 'web', 'app.js'), 'utf8')).toBe('web\n')
    expect(existsSync(join(unpacked, 'packed', 'only.txt'))).toBe(false)
    expect(statFile(destAsar, join('resources', 'nested', 'keep.txt')).unpacked).toBe(true)
    expect(statFile(destAsar, join('out', 'main', 'daemon-entry.js')).unpacked).toBe(true)
    expect(statFile(destAsar, join('out', 'web', 'app.js')).unpacked).toBeUndefined()
    expect(statFile(destAsar, join('packed', 'only.txt')).unpacked).toBeUndefined()
    expect(
      readFileSync(
        join(resources, 'node_modules', '@orca', 'process-host', 'dist', 'index.js'),
        'utf8'
      )
    ).toBe('')
  })

  it('omits development out files from the repacked asar and unpacked tree', async () => {
    root = mkdtempSync(join(tmpdir(), 'sync-win-unpacked-'))
    const repo = join(root, 'repo')
    const outDir = join(repo, 'out')
    for (const name of ['cli', 'main', 'mobile-web', 'shared', 'web']) {
      mkdirSync(join(outDir, name), { recursive: true })
      writeFileSync(join(outDir, name, 'keep.js'), 'keep\n')
    }
    writeFileSync(join(outDir, 'package.json'), '{}\n')
    writeFileSync(join(outDir, 'main', 'daemon-entry.js'), 'daemon\n')
    writeFileSync(join(outDir, 'main', 'daemon-entry.js.map'), 'map\n')
    writeFileSync(join(outDir, 'main', 'foo.test.js'), 'test\n')
    mkdirSync(join(outDir, 'electron-dev', 'cached'), { recursive: true })
    writeFileSync(join(outDir, 'electron-dev', 'cached', 'app'), 'dev\n')
    mkdirSync(join(outDir, 'runtimes', 'node'), { recursive: true })
    writeFileSync(join(outDir, 'runtimes', 'node', 'node'), 'node\n')
    mkdirSync(join(outDir, 'relay'), { recursive: true })
    writeFileSync(join(outDir, 'relay', 'relay.js'), 'relay\n')
    mkdirSync(join(outDir, 'orcad'), { recursive: true })
    writeFileSync(join(outDir, 'orcad', 'orcad.js'), 'orcad\n')
    mkdirSync(join(outDir, 'orcad-prebuild'), { recursive: true })
    writeFileSync(join(outDir, 'orcad-prebuild', 'bin'), 'pre\n')
    mkdirSync(join(outDir, '.orcad-cache'), { recursive: true })
    writeFileSync(join(outDir, '.orcad-cache', 'cache'), 'cache\n')
    mkdirSync(join(outDir, 'node-runtime-cache'), { recursive: true })
    writeFileSync(join(outDir, 'node-runtime-cache', 'node.tar'), 'tar\n')
    mkdirSync(join(outDir, 'renderer', '.vite'), { recursive: true })
    writeFileSync(join(outDir, 'renderer', 'index.js'), 'render\n')
    writeFileSync(join(outDir, 'renderer', '.vite', 'manifest.json'), '{}\n')

    const extractDir = join(root, 'extract')
    mkdirSync(extractDir, { recursive: true })
    const staging = join(root, 'stage')
    await stageFilteredOut(repo, extractDir, staging)

    const packed = listPackage(join(staging, 'app.asar')).map((entry) =>
      entry.replaceAll('\\', '/').replace(/^\//, '')
    )
    const absent = [
      'out/electron-dev',
      'out/runtimes',
      'out/relay',
      'out/orcad',
      'out/orcad-prebuild',
      'out/.orcad-cache',
      'out/node-runtime-cache',
      'out/renderer/.vite',
      'out/main/daemon-entry.js.map',
      'out/main/foo.test.js'
    ]
    for (const rel of absent) {
      expect(packed.some((entry) => entry === rel || entry.startsWith(`${rel}/`))).toBe(false)
    }
    expect(packed).toContain('out/main/daemon-entry.js')
    expect(packed).toContain('out/renderer/index.js')

    const unpackedOut = join(staging, 'app.asar.unpacked', 'out')
    expect(readFileSync(join(unpackedOut, 'main', 'daemon-entry.js'), 'utf8')).toBe('daemon\n')
    expect(existsSync(join(unpackedOut, 'main', 'daemon-entry.js.map'))).toBe(false)
    expect(existsSync(join(unpackedOut, 'main', 'foo.test.js'))).toBe(false)
    expect(existsSync(join(unpackedOut, 'electron-dev'))).toBe(false)
    expect(existsSync(join(unpackedOut, 'runtimes'))).toBe(false)
    expect(existsSync(join(unpackedOut, 'relay'))).toBe(false)
    expect(existsSync(join(unpackedOut, 'orcad'))).toBe(false)
    expect(existsSync(join(unpackedOut, 'orcad-prebuild'))).toBe(false)
    expect(existsSync(join(unpackedOut, '.orcad-cache'))).toBe(false)
    expect(existsSync(join(unpackedOut, 'node-runtime-cache'))).toBe(false)
    expect(existsSync(join(unpackedOut, 'renderer', '.vite'))).toBe(false)
    expect(readFileSync(join(unpackedOut, 'renderer', 'index.js'), 'utf8')).toBe('render\n')
  })
})

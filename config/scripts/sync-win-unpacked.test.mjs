import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPublishTransaction, publishFile, replaceDirectory } from './sync-win-unpacked.mjs'

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
})

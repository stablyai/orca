import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  browserRoutePartitionDirectoryKey,
  browserRoutePartitionPendingDeletesPath,
  deletePendingBrowserRoutePartitionDirectories,
  queueBrowserRoutePartitionDirectoryDelete
} from './browser-route-partition-pending-deletes'

let root: string
let partitions: string
let listPath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-partition-deletes-'))
  partitions = join(root, 'Partitions')
  listPath = browserRoutePartitionPendingDeletesPath(
    join(root, 'profiles', 'a', 'browser-route-partition-bindings.json')
  )
  mkdirSync(join(root, 'profiles', 'a'), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function folder(name: string): string {
  const path = join(partitions, name)
  mkdirSync(path, { recursive: true })
  return path
}

const removeDirectory = (directory: string) => rm(directory, { recursive: true, force: true })

it('keeps the list outside the folder Chromium owns, and queues each folder once', () => {
  const a = folder('a')
  queueBrowserRoutePartitionDirectoryDelete(listPath, a)
  queueBrowserRoutePartitionDirectoryDelete(listPath, a)
  expect(listPath.startsWith(partitions)).toBe(false)
  expect(JSON.parse(readFileSync(listPath, 'utf8'))).toEqual([a])
  expect(existsSync(a)).toBe(true)
})

it('deletes queued folders on the next start and forgets them', async () => {
  const a = folder('a')
  queueBrowserRoutePartitionDirectoryDelete(listPath, a)
  expect(
    await deletePendingBrowserRoutePartitionDirectories({
      filePath: listPath,
      partitionDataRoot: partitions,
      isBound: () => false,
      removeDirectory
    })
  ).toEqual([])
  expect(existsSync(a)).toBe(false)
  expect(JSON.parse(readFileSync(listPath, 'utf8'))).toEqual([])
})

it('keeps a folder bound again since it was queued, and retries one that failed', async () => {
  const rebound = folder('rebound')
  const busy = folder('busy')
  queueBrowserRoutePartitionDirectoryDelete(listPath, rebound)
  queueBrowserRoutePartitionDirectoryDelete(listPath, busy)
  const failures = await deletePendingBrowserRoutePartitionDirectories({
    filePath: listPath,
    partitionDataRoot: partitions,
    isBound: (directory) => directory === rebound,
    removeDirectory: async (directory) => {
      if (directory === busy) {
        throw new Error('EBUSY')
      }
      await removeDirectory(directory)
    }
  })
  expect(failures).toHaveLength(1)
  expect(existsSync(rebound)).toBe(true)
  expect(JSON.parse(readFileSync(listPath, 'utf8'))).toEqual([busy])
})

it('does nothing with no list', async () => {
  expect(
    await deletePendingBrowserRoutePartitionDirectories({
      filePath: listPath,
      partitionDataRoot: partitions,
      isBound: () => false,
      removeDirectory
    })
  ).toEqual([])
  expect(existsSync(listPath)).toBe(false)
})

it('never deletes a listed path that is not strictly inside Partitions', async () => {
  const outside = join(root, 'outside')
  mkdirSync(outside)
  const sibling = join(root, 'Partitions-other')
  mkdirSync(sibling)
  folder('kept')
  writeFileSync(
    listPath,
    JSON.stringify([outside, sibling, partitions, join(partitions, '..', 'outside'), root])
  )
  const removed: string[] = []
  await deletePendingBrowserRoutePartitionDirectories({
    filePath: listPath,
    partitionDataRoot: partitions,
    isBound: () => false,
    removeDirectory: async (directory) => {
      removed.push(directory)
    }
  })
  expect(removed).toEqual([])
  expect(JSON.parse(readFileSync(listPath, 'utf8'))).toEqual([])
})

it('compares Windows partition folders case-insensitively', async () => {
  const winRoot = 'C:\\Users\\Me\\AppData\\Orca\\Partitions'
  expect(browserRoutePartitionDirectoryKey(`${winRoot}\\Abc`, win32.resolve)).toBe(
    browserRoutePartitionDirectoryKey(
      'c:\\users\\me\\appdata\\orca\\partitions\\abc',
      win32.resolve
    )
  )
  writeFileSync(
    listPath,
    JSON.stringify(['c:\\USERS\\me\\appdata\\orca\\PARTITIONS\\abc', `${winRoot}\\..\\x`])
  )
  const removed: string[] = []
  await deletePendingBrowserRoutePartitionDirectories({
    filePath: listPath,
    partitionDataRoot: winRoot,
    isBound: () => false,
    removeDirectory: async (directory) => {
      removed.push(directory)
    },
    resolvePath: win32.resolve
  })
  expect(removed).toEqual(['c:\\USERS\\me\\appdata\\orca\\PARTITIONS\\abc'])
})

it('keeps a folder queued while an earlier delete is in flight', async () => {
  const a = folder('a')
  const late = folder('late')
  queueBrowserRoutePartitionDirectoryDelete(listPath, a)
  await deletePendingBrowserRoutePartitionDirectories({
    filePath: listPath,
    partitionDataRoot: partitions,
    isBound: () => false,
    removeDirectory: async (directory) => {
      queueBrowserRoutePartitionDirectoryDelete(listPath, late)
      await removeDirectory(directory)
    }
  })
  expect(JSON.parse(readFileSync(listPath, 'utf8'))).toEqual([late])
})

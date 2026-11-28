import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const opendirCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FsPromises>()
  return {
    ...fs,
    opendir: (...args: Parameters<typeof fs.opendir>) => {
      opendirCalls.count += 1
      return fs.opendir(...args)
    }
  }
})

import { readDetectionDirectory } from './command-path-directory'

const originalPlatform = process.platform
let root = ''

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

beforeEach(async () => {
  opendirCalls.count = 0
  root = await mkdtemp(path.join(tmpdir(), 'command-path-directory-'))
})

afterEach(async () => {
  setPlatform(originalPlatform)
  await rm(root, { recursive: true, force: true })
})

describe('readDetectionDirectory on Windows', () => {
  it('lists the same names as opendir without calling opendir', async () => {
    await writeFile(path.join(root, 'Tool.CMD'), '')
    await mkdir(path.join(root, 'nested'))
    const posixNames = await readDetectionDirectory(root)

    setPlatform('win32')
    opendirCalls.count = 0
    const windowsNames = await readDetectionDirectory(root)

    expect(posixNames).toEqual(
      new Map([
        ['tool.cmd', 'Tool.CMD'],
        ['nested', 'nested']
      ])
    )
    expect(windowsNames).toEqual(posixNames)
    expect(opendirCalls.count).toBe(0)
  })
})

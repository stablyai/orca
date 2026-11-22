import type * as FileSystem from 'node:fs/promises'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { gate } = vi.hoisted(() => ({
  gate: { held: '', release: () => {}, released: Promise.resolve() }
}))

function holdUntilSharedIsRead(name: string): void {
  gate.held = name
  gate.released = new Promise<void>((settle) => {
    gate.release = settle
  })
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FileSystem>()
  return {
    ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      const name = basename(String(args[0]))
      if (name === gate.held) {
        await gate.released
      }
      if (name === 'shared') {
        gate.release()
      }
      return fs.readFile(...args)
    }
  }
})

import { readLocalGitConfigSignature } from './local-git-config-signature'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'local-git-config-signature-'))
})

afterEach(async () => {
  gate.held = ''
  await rm(root, { recursive: true, force: true })
})

it('signs unchanged config the same whichever include branch reaches a shared include first', async () => {
  await mkdir(join(root, '.git'))
  await writeFile(join(root, '.git', 'config'), '[include]\n\tpath = a\n\tpath = b\n')
  await writeFile(join(root, '.git', 'a'), '[include]\n\tpath = shared\n')
  await writeFile(join(root, '.git', 'b'), '[include]\n\tpath = shared\n')
  await writeFile(join(root, '.git', 'shared'), '[remote "origin"]\n\turl = /x\n')

  holdUntilSharedIsRead('a')
  const sharedReachedThroughB = await readLocalGitConfigSignature({ repoPath: root })
  holdUntilSharedIsRead('b')
  const sharedReachedThroughA = await readLocalGitConfigSignature({ repoPath: root })

  expect(sharedReachedThroughB).toBeDefined()
  expect(sharedReachedThroughA).toBe(sharedReachedThroughB)
})

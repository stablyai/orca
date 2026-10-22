import * as fileOperations from 'node:fs/promises'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as contextSnapshots from './agent-session-context-snapshots'

vi.mock('node:fs/promises', { spy: true })
const actualFiles = await vi.importActual<typeof fileOperations>('node:fs/promises')
const SESSION = 'pr-31782-publication'
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pr-31782-publication-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await actualFiles.rm(contextSnapshots.agentSessionContextSnapshotRoot(root), {
    recursive: true,
    force: true
  })
  await actualFiles.rm(root, { recursive: true, force: true })
})

it('publishes captures in ownership order despite slow staging, dispatched rename, cleanup and a newer failure', async () => {
  const write = actualFiles.writeFile
  const rename = actualFiles.rename
  const remove = actualFiles.rm
  const snapshot = (text: string) =>
    contextSnapshots.writeAgentSessionContextSnapshot(root, SESSION, text)
  const stage = Promise.withResolvers<void>()
  const staged = Promise.withResolvers<void>()
  const writing = vi.spyOn(fileOperations, 'writeFile').mockImplementationOnce(async (...args) => {
    staged.resolve()
    await stage.promise
    return write(...args)
  })
  const old = snapshot('old capture').then(
    () => 'success',
    () => 'replaced'
  )
  await staged.promise
  const path = await snapshot('new capture')
  stage.resolve()
  expect(await old).toBe('replaced')
  expect(await readFile(path, 'utf8')).toBe('new capture')
  const dispatched = Promise.withResolvers<void>()
  const finishRename = Promise.withResolvers<void>()
  const cleaning = Promise.withResolvers<void>()
  const finishCleanup = Promise.withResolvers<void>()
  const successorStaged = Promise.withResolvers<void>()
  let oldPart = ''
  let oldRenameSettled = false
  const renaming = vi
    .spyOn(fileOperations, 'rename')
    .mockImplementationOnce(async (from, to) => {
      oldPart = String(from)
      dispatched.resolve()
      await finishRename.promise
      await rename(from, to)
      oldRenameSettled = true
    })
    .mockImplementation(async (from, to) => {
      expect(oldRenameSettled).toBe(true)
      return rename(from, to)
    })
  renaming.mockClear()
  vi.spyOn(fileOperations, 'rm').mockImplementation(async (target, options) => {
    if (String(target) === oldPart) {
      cleaning.resolve()
      await finishCleanup.promise
    }
    return remove(target, options)
  })
  writing.mockImplementation(async (...args) => {
    await write(...args)
    if (args[1] === 'queued successor') {
      successorStaged.resolve()
    }
  })
  const prior = snapshot('dispatched predecessor').then(
    () => 'success',
    () => 'replaced'
  )
  await dispatched.promise
  const next = snapshot('queued successor')
  await successorStaged.promise
  expect(renaming).toHaveBeenCalledOnce()
  finishRename.resolve()
  await cleaning.promise
  expect(await next).toBe(path)
  expect(await readFile(path, 'utf8')).toBe('queued successor')
  finishCleanup.resolve()
  expect(await prior).toBe('replaced')
  const failedStage = Promise.withResolvers<void>()
  const oldStaged = Promise.withResolvers<void>()
  writing
    .mockImplementationOnce(async (...args) => {
      oldStaged.resolve()
      await failedStage.promise
      return write(...args)
    })
    .mockRejectedValueOnce(new Error('newer stage failed'))
  const revoked = snapshot('must not revive').then(
    () => 'success',
    () => 'replaced'
  )
  await oldStaged.promise
  await expect(snapshot('failed newer capture')).rejects.toThrow('newer stage failed')
  failedStage.resolve()
  expect(await revoked).toBe('replaced')
  expect(await readFile(path, 'utf8')).toBe('queued successor')
})

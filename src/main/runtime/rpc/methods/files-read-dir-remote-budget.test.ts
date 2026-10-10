import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { DirEntry } from '../../../../shared/filesystem-entry-types'
import { FILE_METHODS } from './files'

const HUGE_LISTING: DirEntry[] = Array.from({ length: 80_000 }, (_, index) => ({
  name: `file-${String(index).padStart(5, '0')}.txt`,
  isDirectory: false,
  isSymlink: false
}))

function dispatcherWithListing(entries: DirEntry[]) {
  const runtime = new OrcaRuntimeService()
  vi.spyOn(runtime, 'readFileExplorerDir').mockResolvedValue(entries)
  return new RpcDispatcher({ runtime, methods: FILE_METHODS })
}

async function readDir(clientKind: 'runtime' | undefined) {
  const replies: unknown[] = []
  await dispatcherWithListing(HUGE_LISTING).dispatchStreaming(
    {
      id: 'read-flat',
      authToken: 'tok',
      method: 'files.readDir',
      params: { worktree: 'id:wt-1', relativePath: 'flat' }
    },
    (reply) => replies.push(JSON.parse(reply)),
    { clientKind }
  )
  return replies
}

describe('files.readDir remote reply budget', () => {
  it('refuses a listing a remote reply cannot carry, naming the entry count', async () => {
    expect(await readDir('runtime')).toEqual([
      expect.objectContaining({
        id: 'read-flat',
        ok: false,
        error: {
          code: 'runtime_error',
          message: 'This folder has 80,000 entries, too many to list over a remote connection.'
        }
      })
    ])
  })

  it('keeps the full listing for local callers', async () => {
    expect(await readDir(undefined)).toEqual([
      expect.objectContaining({ ok: true, result: expect.any(Array) })
    ])
    expect(await readDir(undefined)).toMatchObject([{ result: { length: 80_000 } }])
  })
})

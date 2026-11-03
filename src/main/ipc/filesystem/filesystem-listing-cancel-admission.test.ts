import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakePipedChild } from '../../../shared/__fixtures__/fake-spawned-child'
import { FileListingCancelledError } from '../../../shared/file-listing-cancellation'
import type { RuntimeStore } from '../../runtime/runtime-store-contract'

const { authorize, spawn } = vi.hoisted(() => ({ authorize: vi.fn(), spawn: vi.fn() }))

vi.mock('./filesystem-auth', () => ({ resolveAuthorizedPath: authorize }))
vi.mock('../../ripgrep/bundled-ripgrep-spawn', () => ({ spawnBundledRipgrep: spawn }))
vi.mock('../local-worktree-runtime-options', () => ({
  getLocalGitOptionsForRegisteredWorktree: () => ({})
}))

import { listQuickOpenFiles } from './filesystem-list-files'

const store: RuntimeStore = Object.create(null)

function childProcess() {
  return Object.assign(createFakePipedChild(), { exitCode: null, signalCode: null })
}

describe('file listing cancellation before native admission', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    authorize.mockImplementation(async (path: string) => path)
    spawn.mockImplementation(childProcess)
  })

  it('does not authorize or launch an already canceled listing', async () => {
    const controller = new AbortController()
    const reason = new FileListingCancelledError('superseded')
    controller.abort(reason)

    await expect(listQuickOpenFiles('/repo', store, undefined, controller.signal)).rejects.toBe(
      reason
    )
    expect(authorize).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('admits no obsolete scan after a pending authorization', async () => {
    const held = Promise.withResolvers<string>()
    authorize.mockReturnValue(held.promise)
    const reason = new FileListingCancelledError('workspace switched')
    const controller = new AbortController()
    const pending = expect(
      listQuickOpenFiles('/repo', store, undefined, controller.signal)
    ).rejects.toBe(reason)
    controller.abort(reason)
    held.resolve('/repo')
    await pending
    expect(spawn).not.toHaveBeenCalled()
  })

  it('does not start the ignored pass when canceled after the primary pass closes', async () => {
    const primary = childProcess()
    spawn.mockReturnValue(primary)
    const controller = new AbortController()
    const reason = new FileListingCancelledError('closed')
    const listing = listQuickOpenFiles('/repo', store, undefined, controller.signal, 10)
    const rejected = expect(listing).rejects.toBe(reason)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1))
    primary.once('close', () => controller.abort(reason))
    primary.stdout.emit('data', 'src/primary.ts\0')
    primary.emit('close', 0, null)

    await rejected
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(primary.kill).not.toHaveBeenCalled()
  })
})

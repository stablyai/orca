import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RelayContext } from './context'
import { GitHandler } from './git-handler'
import {
  createMockDispatcher,
  type MockDispatcher,
  type RelayDispatcher
} from './git-handler-test-setup'

describe('GitHandler submodule status cancellation', () => {
  let dispatcher: MockDispatcher
  let handler: GitHandler
  let worktreePath: string

  beforeEach(() => {
    worktreePath = mkdtempSync(join(tmpdir(), 'relay-submodule-status-cancel-'))
    dispatcher = createMockDispatcher()
    handler = new GitHandler(dispatcher as unknown as RelayDispatcher, new RelayContext())
  })

  afterEach(async () => {
    handler.dispose()
    await rm(worktreePath, { recursive: true, force: true })
  })

  it('rejects a cancelled request before spawning submodule Git work', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      dispatcher.callRequest(
        'git.submoduleStatus',
        { worktreePath, submodulePath: 'vendor/library' },
        { isStale: () => false, signal: controller.signal }
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

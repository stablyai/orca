import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as NodeProcess from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as WorkspaceSpaceScanBudgetModule from '../shared/workspace-space-scan-budget'
import type { RequestContext } from './dispatcher'

const { budgetState, spawnMock } = vi.hoisted(() => {
  const budgetState: {
    created: number
    duMaxEntries: number | null
    listingMaxEntries: number | null
  } = {
    created: 0,
    duMaxEntries: null,
    listingMaxEntries: null
  }
  return {
    budgetState,
    spawnMock: vi.fn()
  }
})

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

vi.mock('node:process', async () => {
  const actual = await vi.importActual<typeof NodeProcess>('node:process')
  return { ...actual, platform: 'linux' }
})

vi.mock('../shared/workspace-space-scan-budget', async () => {
  const actual = await vi.importActual<typeof WorkspaceSpaceScanBudgetModule>(
    '../shared/workspace-space-scan-budget'
  )
  return {
    ...actual,
    createWorkspaceSpaceScanBudget: () => {
      budgetState.created += 1
      return actual.createWorkspaceSpaceScanBudget(
        budgetState.created === 1 && budgetState.listingMaxEntries
          ? { maxEntries: budgetState.listingMaxEntries }
          : budgetState.created === 2 && budgetState.duMaxEntries
            ? { maxEntries: budgetState.duMaxEntries }
            : undefined
      )
    }
  }
})

import { WorkspaceSpaceScanCapacityError } from '../shared/workspace-space-scan-budget'
import { scanWorkspaceSpaceDirectory } from './workspace-space-scan'

const context: RequestContext = {
  clientId: 1,
  isStale: () => false
}

function createSpawnedDu() {
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const kill = vi.fn()
  return Object.assign(new EventEmitter(), { stdout, stderr, kill })
}

describe('relay workspace space scan du path', () => {
  let tempDir: string | null = null

  afterEach(async () => {
    budgetState.created = 0
    budgetState.duMaxEntries = null
    budgetState.listingMaxEntries = null
    spawnMock.mockReset()
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
      tempDir = null
    }
  })

  it('fails closed instead of repeating the traversal through the portable walker', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'orca-relay-du-capacity-'))
    const rootPath = join(tempDir, 'repo')
    await mkdir(rootPath, { recursive: true })
    await Promise.all(['one', 'two', 'three'].map((name) => writeFile(join(rootPath, name), name)))
    budgetState.listingMaxEntries = 2
    spawnMock.mockReturnValue(createSpawnedDu())

    await expect(scanWorkspaceSpaceDirectory(rootPath, context)).rejects.toBeInstanceOf(
      WorkspaceSpaceScanCapacityError
    )
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('kills du and fails closed when streamed rows exceed the retained budget', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'orca-relay-du-capacity-'))
    const rootPath = join(tempDir, 'repo')
    await mkdir(rootPath, { recursive: true })
    await writeFile(join(rootPath, 'one'), 'one')
    budgetState.duMaxEntries = 2
    const child = createSpawnedDu()
    spawnMock.mockReturnValue(child)

    const scanPromise = scanWorkspaceSpaceDirectory(rootPath, context)
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
    const rejection = expect(scanPromise).rejects.toBeInstanceOf(WorkspaceSpaceScanCapacityError)
    child.stdout.emit('data', Buffer.from(`1\t${join(rootPath, 'one')}\n`))
    child.stdout.emit('data', Buffer.from(`1\t${join(rootPath, 'two')}\n`))
    child.stdout.emit('data', Buffer.from(`1\t${join(rootPath, 'three')}\n`))
    child.emit('close', 0)

    await rejection
    expect(child.kill).toHaveBeenCalled()
  })
})

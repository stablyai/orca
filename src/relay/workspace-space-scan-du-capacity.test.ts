import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as NodeProcess from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as WorkspaceSpaceScanBudgetModule from '../shared/workspace-space-scan-budget'
import type { RequestContext } from './dispatcher'

const { execFileMock, budgetState } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  budgetState: { created: 0 }
}))

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

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
    // Why: only the du path's top-level listing is capped, so a swallowed
    // capacity error would let the portable retry succeed and fail this test.
    createWorkspaceSpaceScanBudget: () => {
      budgetState.created += 1
      return actual.createWorkspaceSpaceScanBudget(
        budgetState.created === 1 ? { maxEntries: 2 } : undefined
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

describe('relay workspace space scan du path', () => {
  let tempDir: string | null = null

  afterEach(async () => {
    execFileMock.mockReset()
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
    execFileMock.mockImplementation(
      (
        _file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, output: { stdout: string; stderr: string }) => void
      ) => {
        callback(null, { stdout: `1\t${args.at(-1)}\n`, stderr: '' })
        return { kill: vi.fn() }
      }
    )

    await expect(scanWorkspaceSpaceDirectory(rootPath, context)).rejects.toBeInstanceOf(
      WorkspaceSpaceScanCapacityError
    )
    expect(execFileMock).toHaveBeenCalledWith(
      'du',
      ['-k', '-d', '1', rootPath],
      expect.any(Object),
      expect.any(Function)
    )
  })
})

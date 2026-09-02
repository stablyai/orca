import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as NodeProcess from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as WorkspaceSpaceScanBudgetModule from '../shared/workspace-space-scan-budget'
import type { RequestContext } from './dispatcher'

vi.mock('node:process', async () => {
  const actual = await vi.importActual<typeof NodeProcess>('node:process')
  return { ...actual, platform: 'win32' }
})

vi.mock('../shared/workspace-space-scan-budget', async () => {
  const actual = await vi.importActual<typeof WorkspaceSpaceScanBudgetModule>(
    '../shared/workspace-space-scan-budget'
  )
  return {
    ...actual,
    createWorkspaceSpaceScanBudget: () => actual.createWorkspaceSpaceScanBudget({ maxEntries: 2 })
  }
})

import { WorkspaceSpaceScanCapacityError } from '../shared/workspace-space-scan-budget'
import { scanWorkspaceSpaceDirectory } from './workspace-space-scan'

const context: RequestContext = {
  clientId: 1,
  isStale: () => false
}

describe('relay workspace space scan', () => {
  let tempDir: string | null = null

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
      tempDir = null
    }
  })

  it('fails closed when the portable scan exceeds its entry budget', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'orca-relay-space-capacity-'))
    const rootPath = join(tempDir, 'repo')
    await mkdir(rootPath, { recursive: true })
    await Promise.all(['one', 'two', 'three'].map((name) => writeFile(join(rootPath, name), name)))

    await expect(scanWorkspaceSpaceDirectory(rootPath, context)).rejects.toBeInstanceOf(
      WorkspaceSpaceScanCapacityError
    )
  })
})

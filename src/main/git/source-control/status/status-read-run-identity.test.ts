import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as OperationRunIdentity from '../mutations/operation-run-identity'
import type * as StatusPorcelainStream from './status-porcelain-stream'
import { getStatus } from './status-read'

// Records the order of status's identity reads and its porcelain snapshot, and lets a case
// replace what an identity read returns.
const observed = vi.hoisted(() => {
  const state: {
    events: string[]
    identityReads: number
    onRead: ((index: number, actual: string | null) => string | null) | null
  } = { events: [], identityReads: 0, onRead: null }
  return state
})
vi.mock('../mutations/operation-run-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof OperationRunIdentity>()
  return {
    ...actual,
    readOperationRunIdentity: async (
      ...args: Parameters<typeof actual.readOperationRunIdentity>
    ) => {
      const index = observed.identityReads++
      observed.events.push(`identity ${index} start`)
      const read = await actual.readOperationRunIdentity(...args)
      // Recorded on completion, so the order shows the snapshot waits for the first read to finish.
      observed.events.push(`identity ${index} end`)
      return observed.onRead ? observed.onRead(index, read) : read
    }
  }
})
vi.mock('./status-porcelain-stream', async (importOriginal) => {
  const actual = await importOriginal<typeof StatusPorcelainStream>()
  return {
    ...actual,
    readStatusPorcelain: async (...args: Parameters<typeof actual.readStatusPorcelain>) => {
      observed.events.push('snapshot start')
      const result = await actual.readStatusPorcelain(...args)
      observed.events.push('snapshot end')
      return result
    }
  }
})

describe('status run identity', () => {
  const tempPaths: string[] = []

  afterEach(() => {
    observed.events = []
    observed.identityReads = 0
    observed.onRead = null
    for (const path of tempPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  function createPausedMerge(): string {
    const repoPath = mkdtempSync(join(tmpdir(), 'orca-status-run-identity-'))
    tempPaths.push(repoPath)
    const git = (...args: string[]) => {
      try {
        execFileSync('git', args, { cwd: repoPath, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        // A conflicted merge exits non-zero by design.
        if (args[0] !== 'merge') {
          throw error
        }
      }
    }
    const write = (text: string) => writeFileSync(join(repoPath, 'app.txt'), text)
    git('init', '--quiet', '-b', 'main')
    git('config', 'user.name', 'Orca Test')
    git('config', 'user.email', 'orca@example.test')
    git('config', 'commit.gpgSign', 'false')
    git('config', 'core.hooksPath', '.git/no-hooks')
    write('base\n')
    git('add', '.')
    git('commit', '--quiet', '-m', 'base')
    git('checkout', '--quiet', '-b', 'other')
    write('other\n')
    git('commit', '--quiet', '-am', 'other')
    git('checkout', '--quiet', 'main')
    write('main\n')
    git('commit', '--quiet', '-am', 'main')
    git('merge', 'other')
    return repoPath
  }

  it('brackets the porcelain snapshot between two identity reads', async () => {
    const repoPath = createPausedMerge()
    const status = await getStatus(repoPath, { includeLineStats: false })
    expect(status.conflictOperation).toBe('merge')
    expect(observed.events).toEqual([
      'identity 0 start',
      'identity 0 end',
      'snapshot start',
      'snapshot end',
      'identity 1 start',
      'identity 1 end'
    ])
    expect(status.operationRunIdentity).toMatch(/^MERGE_HEAD:/)
  })

  it('reports null when the run changed while the snapshot was taken', async () => {
    const repoPath = createPausedMerge()
    observed.onRead = (index) => (index === 0 ? 'run A' : 'run B')
    const status = await getStatus(repoPath, { includeLineStats: false })
    expect(status.conflictOperation).toBe('merge')
    // Null, not absent: a current host that can't vouch for the run, not an older host.
    expect(status).toHaveProperty('operationRunIdentity', null)
  })
})

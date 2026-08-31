import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { runProcessSyncMock } = vi.hoisted(() => ({ runProcessSyncMock: vi.fn() }))

vi.mock('../../shared/child-process/run-process', () => ({
  runProcessSync: runProcessSyncMock
}))

import { NO_GITHUB_AUTHORITY_POLICY_DIGEST } from '../../shared/worker-authority-policy'
import {
  WORKER_AUTHORITY_CID_FILE,
  WORKER_AUTHORITY_DAEMON_OWNER_FILE,
  WORKER_AUTHORITY_NONCE_LABEL,
  WORKER_AUTHORITY_OWNERSHIP_FILE,
  WORKER_AUTHORITY_POLICY_LABEL,
  WORKER_AUTHORITY_ROOT_LABEL,
  WORKER_AUTHORITY_ROOT_PREFIX
} from './worker-authority-container-contract'
import { recoverOrphanedWorkerAuthorityContainers } from './worker-authority-orphan-recovery'

describe('worker authority orphan recovery', () => {
  const roots: string[] = []

  afterEach(() => {
    runProcessSyncMock.mockReset()
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function fixture() {
    const tempRoot = mkdtempSync('/private/tmp/orca-authority-recovery-test-')
    roots.push(tempRoot)
    const root = mkdtempSync(join(tempRoot, WORKER_AUTHORITY_ROOT_PREFIX))
    const nonce = 'a'.repeat(64)
    const cid = 'b'.repeat(64)
    writeFileSync(join(root, WORKER_AUTHORITY_OWNERSHIP_FILE), nonce, { mode: 0o600 })
    writeFileSync(join(root, WORKER_AUTHORITY_CID_FILE), cid, { mode: 0o600 })
    writeFileSync(
      join(root, WORKER_AUTHORITY_DAEMON_OWNER_FILE),
      JSON.stringify({
        schemaVersion: 'worker_authority_daemon_owner/1',
        pid: 12345,
        startedAtMs: 1_700_000_000_000,
        launchNonce: 'synthetic-daemon',
        socketPath: join(tempRoot, 'daemon.sock'),
        tokenPath: join(tempRoot, 'daemon.token')
      }),
      { mode: 0o600 }
    )
    return { tempRoot, root, nonce, cid }
  }

  function recover(tempRoot: string, ownerState: 'present' | 'gone' | 'unknown' = 'gone') {
    return recoverOrphanedWorkerAuthorityContainers({
      platform: 'darwin',
      tempRoot,
      probeOwner: async () => ownerState
    })
  }

  it('removes a container only when the private record matches its labels', async () => {
    const f = fixture()
    runProcessSyncMock
      .mockReturnValueOnce({
        code: 0,
        stdout: JSON.stringify({
          [WORKER_AUTHORITY_POLICY_LABEL]: NO_GITHUB_AUTHORITY_POLICY_DIGEST,
          [WORKER_AUTHORITY_ROOT_LABEL]: f.root,
          [WORKER_AUTHORITY_NONCE_LABEL]: f.nonce
        }),
        stderr: '',
        signal: null,
        timedOut: false
      })
      .mockReturnValueOnce({
        code: 0,
        stdout: f.cid,
        stderr: '',
        signal: null,
        timedOut: false
      })

    await expect(recover(f.tempRoot)).resolves.toEqual({
      removedContainers: 1,
      removedRoots: 1,
      rejectedRoots: 0
    })
    expect(runProcessSyncMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ args: ['rm', '--force', f.cid] })
    )
    expect(existsSync(f.root)).toBe(false)
  })

  it('retains a root and container when any ownership label mismatches', async () => {
    const f = fixture()
    runProcessSyncMock.mockReturnValue({
      code: 0,
      stdout: JSON.stringify({
        [WORKER_AUTHORITY_POLICY_LABEL]: NO_GITHUB_AUTHORITY_POLICY_DIGEST,
        [WORKER_AUTHORITY_ROOT_LABEL]: f.root,
        [WORKER_AUTHORITY_NONCE_LABEL]: 'c'.repeat(64)
      }),
      stderr: '',
      signal: null,
      timedOut: false
    })

    await expect(recover(f.tempRoot)).resolves.toEqual({
      removedContainers: 0,
      removedRoots: 0,
      rejectedRoots: 1
    })
    expect(runProcessSyncMock).toHaveBeenCalledTimes(1)
    expect(existsSync(f.root)).toBe(true)
  })

  it('retains the private record when Docker cannot prove the container is absent', async () => {
    const f = fixture()
    runProcessSyncMock
      .mockReturnValueOnce({
        code: 1,
        stdout: '',
        stderr: 'cannot connect to Docker',
        signal: null,
        timedOut: false
      })
      .mockReturnValueOnce({
        code: 1,
        stdout: '',
        stderr: 'cannot connect to Docker',
        signal: null,
        timedOut: false
      })

    await expect(recover(f.tempRoot)).resolves.toEqual({
      removedContainers: 0,
      removedRoots: 0,
      rejectedRoots: 1
    })
    expect(runProcessSyncMock).toHaveBeenCalledTimes(2)
    expect(existsSync(f.root)).toBe(true)
  })

  it('removes an owned private record only after Docker proves its CID is absent', async () => {
    const f = fixture()
    runProcessSyncMock
      .mockReturnValueOnce({
        code: 1,
        stdout: '',
        stderr: 'No such object',
        signal: null,
        timedOut: false
      })
      .mockReturnValueOnce({
        code: 0,
        stdout: '',
        stderr: '',
        signal: null,
        timedOut: false
      })

    await expect(recover(f.tempRoot)).resolves.toEqual({
      removedContainers: 0,
      removedRoots: 1,
      rejectedRoots: 0
    })
    expect(existsSync(f.root)).toBe(false)
  })

  it('ignores other temp directories and rejects incomplete ownership records', async () => {
    const f = fixture()
    rmSync(join(f.root, WORKER_AUTHORITY_CID_FILE))
    mkdirSync(join(f.tempRoot, 'not-orca-owned'))

    await expect(recover(f.tempRoot)).resolves.toEqual({
      removedContainers: 0,
      removedRoots: 0,
      rejectedRoots: 1
    })
    expect(runProcessSyncMock).not.toHaveBeenCalled()
  })

  it.each(['present', 'unknown'] as const)(
    'retains an owned container when its daemon owner is %s',
    async (ownerState) => {
      const f = fixture()

      await expect(recover(f.tempRoot, ownerState)).resolves.toEqual({
        removedContainers: 0,
        removedRoots: 0,
        rejectedRoots: 1
      })
      expect(runProcessSyncMock).not.toHaveBeenCalled()
      expect(existsSync(f.root)).toBe(true)
    }
  )
})

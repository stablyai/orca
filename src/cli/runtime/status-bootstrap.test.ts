import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { getRuntimeMetadataPath } from '../../shared/runtime-bootstrap'
import { getCliStatus } from './status'

function writeMetadata(userDataPath: string, authToken: string | null, pid: number): void {
  writeFileSync(
    getRuntimeMetadataPath(userDataPath),
    JSON.stringify({
      runtimeId: 'runtime-1',
      pid,
      transports: [
        {
          kind: 'unix',
          endpoint: ''
        }
      ],
      authToken,
      startedAt: 1
    }),
    'utf8'
  )
}

function findUnusedPid(seed = 200_000): number {
  // Why: the stale-bootstrap test must point metadata at a definitely-dead
  // process. Hard-coding a small PID is host-dependent and flakes when that
  // PID happens to be alive on the machine running the suite.
  let pid = Math.max(seed, process.pid + 10_000)
  while (pid < 2_000_000) {
    try {
      process.kill(pid, 0)
      pid += 1
    } catch {
      return pid
    }
  }
  return 2_000_000
}

it('reports not_running when no runtime metadata exists', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-status-'))

  const status = await getCliStatus(userDataPath)

  expect(status.result).toEqual({
    app: {
      running: false,
      pid: null
    },
    runtime: {
      state: 'not_running',
      reachable: false,
      runtimeId: null
    },
    graph: {
      state: 'not_running'
    }
  })
})

it('reports starting when incomplete bootstrap metadata points to the live app', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-status-'))
  writeMetadata(userDataPath, null, process.pid)

  const status = await getCliStatus(userDataPath)

  expect(status.result).toEqual({
    app: {
      running: true,
      pid: process.pid
    },
    runtime: {
      state: 'starting',
      reachable: false,
      runtimeId: null
    },
    graph: {
      state: 'starting'
    }
  })
})

it('keeps stale_bootstrap when incomplete bootstrap metadata points to a dead app', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-status-'))
  writeMetadata(userDataPath, null, findUnusedPid())

  const status = await getCliStatus(userDataPath)

  expect(status.result).toEqual({
    app: {
      running: false,
      pid: null
    },
    runtime: {
      state: 'stale_bootstrap',
      reachable: false,
      runtimeId: null
    },
    graph: {
      state: 'not_running'
    }
  })
})

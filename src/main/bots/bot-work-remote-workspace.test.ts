import { describe, expect, it } from 'vitest'
import { readRemoteWorkspace, type BotWorkRemoteRuntime } from './bot-work-remote-workspace'
import type { BotWorkWorker } from './bot-work-types'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read uses only these worker fields.
const worker = {
  dispatchId: 'ctx_remote',
  host: 'env-1',
  worktreeId: 'repo-s::/srv/p2-child'
} as BotWorkWorker

// The server answers as a paired Orca does; `fingerprint` is who answers now.
function runtimeOn(fingerprint: string) {
  const answers: Record<string, unknown> = {
    'worktree.show': {
      worktree: {
        displayName: 'p2-child',
        branch: 'refs/heads/p2-child',
        head: 'abc123'
      }
    }
  }
  return {
    getOrchestrationDb: () => ({
      getFederatedDispatch: () => ({
        environment_id: 'env-1',
        environment_name: 'srv2',
        peer_fingerprint: 'peer-at-start'
      })
    }),
    resolveOrchestrationWorkerServer: () => ({
      environmentId: 'env-1',
      name: 'srv2',
      peerFingerprint: fingerprint,
      pairingRevision: 1
    }),
    callOrchestrationWorkerServer: async (_env: string, method: string) => answers[method]
  }
}

function readOn(fingerprint: string) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the read uses only these runtime members.
  const runtime = runtimeOn(fingerprint) as unknown as BotWorkRemoteRuntime
  return readRemoteWorkspace(runtime, worker)
}

describe('readRemoteWorkspace', () => {
  it("reads a paired server worker's branch and head there", async () => {
    const workspace = await readOn('peer-at-start')
    expect(workspace).toEqual({
      name: 'p2-child',
      branch: 'refs/heads/p2-child',
      head: 'abc123',
      pullRequest: null
    })
  })

  it('never asks a re-paired machine about the worker', async () => {
    await expect(readOn('another-peer')).rejects.toMatchObject({ code: 'peer_changed' })
  })
})

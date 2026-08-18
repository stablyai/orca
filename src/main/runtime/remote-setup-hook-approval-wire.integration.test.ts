import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getDefaultRepoHookSettings } from '../../shared/constants'
import { parsePairingCode } from '../../shared/pairing'
import { RemoteRuntimeRequestConnection } from '../../shared/remote-runtime-request-connection'
import type { Repo } from '../../shared/repo-types'
import type { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

const REQUEST_TIMEOUT_MS = 5_000

type SetupHookApproval = {
  kind: 'setup'
  token: string
  contentHash: string
}

function hash(content: string): string {
  return createHash('sha256').update(content.trim()).digest('hex')
}

describe('remote setup-hook approval wire binding', () => {
  it('does not execute host content that differs from the paired-client approval', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-setup-approval-wire-'))
    const markerPath = join(userDataPath, 'executed-hook.txt')
    const repo: Repo = {
      id: 'repo-1',
      path: join(userDataPath, 'repo'),
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      hookSettings: getDefaultRepoHookSettings(),
      worktreeBaseRef: 'main',
      kind: 'git'
    }
    const approvedContent = 'node approved-a.js'
    const hostContent = 'node host-b.js'
    const approval: SetupHookApproval = {
      kind: 'setup',
      token: 'approval-for-a',
      contentHash: hash(approvedContent)
    }
    let forwardedApproval: SetupHookApproval | undefined
    const runtime = {
      getRuntimeId: () => 'setup-approval-runtime',
      getStartedAt: () => 1,
      cleanupSubscriptionsForConnection: () => {},
      cancelMobileDictationForConnection: () => {},
      onClientDisconnected: () => {},
      showRepo: () => repo,
      dedupeWorktreeCreate: <T>(
        _repo: string,
        _mutationId: string | undefined,
        run: () => Promise<T>
      ) => run(),
      createManagedWorktree: async (args: Record<string, unknown>) => {
        forwardedApproval = args.setupHookApproval as SetupHookApproval | undefined
        // Mirrors the legacy host: absent proof means setupDecision alone authorizes execution.
        if (!forwardedApproval || forwardedApproval.contentHash === hash(hostContent)) {
          writeFileSync(markerPath, hostContent)
        }
        return {
          worktree: {
            id: `${repo.id}::created`,
            repoId: repo.id,
            path: join(userDataPath, 'created'),
            branch: 'created',
            displayName: 'created',
            isMainWorktree: false
          }
        }
      }
    } as unknown as OrcaRuntimeService
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()
    try {
      const offer = server.createPairingOffer({ name: 'paired-client', scope: 'runtime' })
      if (!offer.available) {
        throw new Error('pairing unavailable')
      }
      const pairing = parsePairingCode(offer.pairingUrl)
      if (!pairing) {
        throw new Error('invalid pairing')
      }
      const connection = new RemoteRuntimeRequestConnection(pairing)
      try {
        const response = await connection.request(
          'worktree.create',
          {
            repo: repo.id,
            name: 'created',
            setupDecision: 'run',
            setupHookApproval: approval
          },
          REQUEST_TIMEOUT_MS
        )

        expect(response).toMatchObject({ ok: true })
        expect(hash(hostContent)).not.toBe(approval.contentHash)
        expect.soft(forwardedApproval).toEqual(approval)
        expect.soft(existsSync(markerPath)).toBe(false)
      } finally {
        connection.close()
      }
    } finally {
      await server.stop()
      if (existsSync(markerPath)) {
        expect(readFileSync(markerPath, 'utf8')).toBe(hostContent)
      }
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})

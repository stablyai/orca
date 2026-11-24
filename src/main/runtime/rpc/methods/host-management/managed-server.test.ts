import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcadTerminalCensus } from '../../../../../shared/remote-runtime/orcad-lifecycle/orcad-terminal-census'
import {
  MANAGED_SERVER_LIMITED_FORCE_RUNTIME_CAPABILITY,
  MANAGED_SERVER_RUNTIME_CAPABILITY
} from '../../../../../shared/remote-runtime/protocol/host-runtime-capabilities'
import type { RemovedServerStore } from '../../../../ipc/runtime-environments/catalog/runtime-environment-removal-cleanup'
import { createManagedOrcadActions } from '../../../../ipc/runtime-environments/managed-orcad/managed-orcad-actions'
import { emptyOrcadActivationRecord } from '../../../../managed-server/activation/orcad-activation-record'
import { CURRENT_ORCAD_DAEMON_PROTOCOL } from '../../../../managed-server/activation/orcad-daemon-protocol-crossing'
import { planOrcadUpdate } from '../../../../managed-server/activation/orcad-update-plan'
import { managedOrcadUpdateForce } from '../../../../managed-server/lifecycle/orcad-managed-update-decision'
import { updateManagedOrcadEnvironment } from '../../../../managed-server/lifecycle/orcad-runtime-maintenance'
import { registerManagedServerActions } from '../../../hosts/management/managed-server-actions-registry'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { eraseRpcMethods, isStreamingMethod, type RpcContext } from '../../core'
import '../rpc-method-registry'
import { MANAGED_SERVER_METHODS } from './managed-server'

vi.mock('../../../../managed-server/lifecycle/orcad-runtime-maintenance', () => ({
  updateManagedOrcadEnvironment: vi.fn(async () => ({ outcome: 'deferred' }))
}))

// What a released orcad answers when its daemon never started: no session or in-process count.
const UNCOUNTED: OrcadTerminalCensus = {
  liveSessions: null,
  startedSinceActivation: null,
  daemonProtocolVersion: null,
  answered: true
}

const MARKERS = [MANAGED_SERVER_RUNTIME_CAPABILITY, MANAGED_SERVER_LIMITED_FORCE_RUNTIME_CAPABILITY]

let userDataPath: string | null = null

afterEach(() => {
  registerManagedServerActions(null)
  if (userDataPath) {
    rmSync(userDataPath, { recursive: true, force: true })
    userDataPath = null
  }
})

function updateMethod() {
  const method = eraseRpcMethods(MANAGED_SERVER_METHODS).find(
    (candidate) => candidate.name === 'managedServer.update'
  )
  if (!method || isStreamingMethod(method)) {
    throw new Error('Missing managedServer.update')
  }
  return method
}

describe('managedServer.update limited force', () => {
  it('advertises limited force only where bare force reaches the planner as limited force', async () => {
    const runtime = new OrcaRuntimeService()
    for (const marker of MARKERS) {
      expect(runtime.getStatus().capabilities).not.toContain(marker)
    }

    const root = mkdtempSync(join(tmpdir(), 'orca-managed-'))
    userDataPath = root
    registerManagedServerActions(
      createManagedOrcadActions({
        getUserDataPath: () => root,
        getActiveEnvironmentId: () => null,
        invalidateTransport: () => {},
        clearHostServerNotes: () => {},
        clearHostServerStatus: () => {},
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: update never retires a server, so it never reads the store.
        store: {} as RemovedServerStore
      })
    )
    expect(runtime.getStatus().capabilities).toEqual(expect.arrayContaining(MARKERS))

    // The exact frame a current CLI sends for bare --force, through the real RPC and desktop adapter.
    const method = updateMethod()
    const context: RpcContext = { runtime, clientKind: 'runtime' }
    await method.handler(method.params?.parse({ selector: 'build-box', force: true }), context)
    expect(vi.mocked(updateManagedOrcadEnvironment)).toHaveBeenCalledWith(root, {
      selector: 'build-box',
      force: true
    })

    const [, args] = vi.mocked(updateManagedOrcadEnvironment).mock.calls[0]!
    const plan = planOrcadUpdate({
      record: { ...emptyOrcadActivationRecord(), active: 'v1' },
      candidateVersion: 'v2',
      census: UNCOUNTED,
      candidateDaemonProtocol: CURRENT_ORCAD_DAEMON_PROTOCOL,
      // No daemon alive: full force here would end every terminal orcad runs itself.
      hostDaemonProtocols: [],
      force: managedOrcadUpdateForce(args)
    })
    expect(plan).toMatchObject({ action: 'defer', forceable: true })
  })
})

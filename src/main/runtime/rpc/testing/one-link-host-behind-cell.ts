// A real host behind a stand-in Relay cell, reached by a control connection that is its one link.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePairingCode } from '../../../../shared/remote-runtime/pairing/pairing'
import { pairedRuntimeConnectionFromOffer } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { RemoteRuntimeSharedControlConnection } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-connection'
import {
  clearRemoteRuntimeOneLink,
  setRemoteRuntimeOneLink
} from '../../../../shared/remote-runtime/control/remote-runtime-one-link'
import type { RpcAnyMethodDeclaration } from '../core'
import { STATUS_METHODS } from '../methods/host-management/status'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from '../server/runtime-rpc'
import { startRelayCellStandIn } from './relay-cell-stand-in'

export async function startOneLinkHostBehindCell(
  methods: readonly RpcAnyMethodDeclaration[],
  cleanups: (() => Promise<void> | void)[]
) {
  const userDataPath = await mkdtemp(join(tmpdir(), 'orca-one-link-'))
  const server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath,
    enableWebSocket: true,
    wsPort: 0,
    methods: [...STATUS_METHODS, ...methods]
  })
  await server.start()
  cleanups.push(async () => {
    await server.stop().catch(() => {})
    await rm(userDataPath, { recursive: true, force: true })
  })
  const offer = server.createPairingOffer({ address: '127.0.0.1', scope: 'runtime', name: 'Desk' })
  if (!offer.available) {
    throw new Error('WebSocket pairing unavailable')
  }
  const direct = pairedRuntimeConnectionFromOffer(parsePairingCode(offer.pairingUrl)!)
  const cell = await startRelayCellStandIn(direct.endpoint)
  cleanups.push(() => cell.close())
  const connection = { ...direct, endpoint: cell.url }
  const link = new RemoteRuntimeSharedControlConnection(connection, {
    environmentId: 'one-link-test',
    binaryChannels: true,
    appHeartbeat: {}
  })
  setRemoteRuntimeOneLink('one-link-test', connection, () => link)
  cleanups.push(() => {
    clearRemoteRuntimeOneLink('one-link-test')
    link.close()
  })
  return { server, cell, connection, link }
}

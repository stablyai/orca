import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
// A phone is named through the declaration its desktop really sends: host.declareAccount on the
// desktop's socket, then the delegation sync or offer that socket's installation made.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { PAIRING_METHODS } from '../methods/pairing/pairing'
import {
  DECLARE_ORCA_ACCOUNT_METHOD,
  DeclareOrcaAccountParamsSchema
} from '../../../../shared/remote-runtime/pairing/paired-desktop-account-contract'
import type { RpcContext } from '../core'

vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const facade = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: facade.listWorktrees
  }
})

vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const facade = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: facade.listWorktreesStrict
  }
})

const { getWorktreeListingMocks } = vi.hoisted(() => {
  const createWorktreeListingMocks = () => ({
    listWorktrees: vi.fn().mockResolvedValue([]),
    listWorktreesStrict: vi.fn().mockResolvedValue([])
  })
  let listings: ReturnType<typeof createWorktreeListingMocks> | undefined
  return { getWorktreeListingMocks: () => (listings ??= createWorktreeListingMocks()) }
})

let server: OrcaRuntimeRpcServer
let runtime: OrcaRuntimeService

beforeEach(async () => {
  server = new OrcaRuntimeRpcServer({
    runtime: (runtime = new OrcaRuntimeService()),
    userDataPath: mkdtempSync(join(tmpdir(), 'orca-paired-phone-typist-')),
    enableWebSocket: true,
    wsPort: 0
  })
  await server.start()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await server.stop()
})

function pairDesktop(): string {
  const offer = server.createPairingOffer({
    address: '127.0.0.1',
    name: 'desktop',
    scope: 'runtime'
  })
  if (!offer.available) {
    throw new Error('WebSocket pairing unavailable')
  }
  return offer.deviceId
}

// What the desktop's socket sends on ready, through the host's own handler and schema.
async function declare(deviceId: string, connectionId: string, params: unknown): Promise<void> {
  const method = PAIRING_METHODS.find((candidate) => candidate.name === DECLARE_ORCA_ACCOUNT_METHOD)
  const deviceSelf = server['desktopAccountSelf']({ deviceId, scope: 'runtime' }, connectionId)
  const context: RpcContext = {
    runtime,
    deviceSelf: {
      ...deviceSelf,
      registerDeviceKey: () => {
        throw new Error('unused')
      },
      exchangePairingTicket: () => {
        throw new Error('unused')
      }
    }
  }
  await method?.handler(DeclareOrcaAccountParamsSchema.parse(params), context)
}

function syncPhone(parentDeviceId: string, connectionId: string, phoneKey: string, name: string) {
  const [phone] = server['syncDelegatedMobileDevices'](
    parentDeviceId,
    [{ phoneKey, name }],
    connectionId
  ).devices
  return phone!.deviceId
}

const sam = { id: 'acct-sam', name: 'Sam Lee', computer: "Sam's MacBook Pro" }
const owner = { id: 'acct-owner', name: 'Jin', computer: 'Studio Mac' }

describe("a paired phone's sender, through the real declaration", () => {
  it('names a relayed phone by the installation that synced it, whoever declared last on its row', async () => {
    const row = pairDesktop()
    await declare(row, 'conn-sam', { account: sam, clientInstanceId: 'install-sam' })
    const phone = syncPhone(row, 'conn-sam', 'sam-phone', "iPhone via Sam's MacBook Pro")
    await declare(row, 'conn-owner', { account: owner, clientInstanceId: 'install-owner' })

    expect(server.pairedDeviceTypist(phone)).toEqual({ ...sam, phone: 'iPhone' })
  })

  it('never credits a teammate whose installation id matches on another paired row', async () => {
    const samRow = pairDesktop()
    const otherRow = pairDesktop()
    await declare(otherRow, 'conn-other', { account: owner, clientInstanceId: 'same-id' })
    const phone = syncPhone(samRow, 'conn-sam', 'sam-phone', 'iPhone via Mac')
    await declare(samRow, 'conn-sam', { account: sam, clientInstanceId: 'same-id' })

    expect(server.pairedDeviceTypist(phone)).toBeNull()
  })
})

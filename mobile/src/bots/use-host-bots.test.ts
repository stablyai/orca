import { describe, expect, it } from 'vitest'
import { BOTS_MOBILE_RUNTIME_CAPABILITY } from '../../../src/shared/bot-runtime-capabilities'
import {
  createFakeRpcClient,
  rpcSuccess
} from '../mobile-web-shell/test-support/bridge-host-test-fakes'
import { readHostBotListing, type ListingTarget } from './use-host-bots'

const TARGET: ListingTarget = {
  hostId: 'ssh:server-1',
  hostLabel: 'Server',
  client: createFakeRpcClient(),
  key: 'paired-1\nserver-1',
  relaysCreate: true
}

const BOT = {
  id: 'bot-1',
  name: 'Bot',
  folder: 'bot',
  folderWorkspaceId: 'folder-1',
  avatar: null,
  paused: false,
  agent: 'codex',
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null
}

async function readWithUnavailableLineage(name: string) {
  const client = createFakeRpcClient()
  const target = { ...TARGET, client }
  const listing = readHostBotListing(target, true)

  await Promise.resolve()
  client.requests[0]?.resolve(rpcSuccess({ capabilities: [BOTS_MOBILE_RUNTIME_CAPABILITY] }))
  await Promise.resolve()
  client.requests[1]?.resolve(
    rpcSuccess({
      bots: [{ ...BOT, name }],
      botsEnabled: true,
      hideBotCreatedWorkspaces: false
    })
  )
  await Promise.resolve()
  client.requests[2]?.resolve({
    id: 'rpc-1',
    ok: false,
    error: { code: 'unavailable', message: 'lineage unavailable' }
  })
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  client.requests.slice(3).forEach((request) =>
    request.resolve({
      id: 'rpc-1',
      ok: false,
      error: { code: 'unavailable', message: 'ancillary read unavailable' }
    })
  )

  return listing
}

describe('readHostBotListing', () => {
  it('keeps the initial bot listing when worker lineage is unavailable', async () => {
    const listing = await readWithUnavailableLineage('Initial bot')

    expect(listing).toMatchObject({
      kind: 'listed',
      workerStatus: 'unavailable',
      bots: [{ id: 'bot-1', name: 'Initial bot' }],
      workspaceLineage: {},
      worktreeLineage: {}
    })
  })

  it('keeps a refreshed bot listing when worker lineage is unavailable', async () => {
    const listing = await readWithUnavailableLineage('Refreshed bot')

    expect(listing).toMatchObject({
      kind: 'listed',
      workerStatus: 'unavailable',
      bots: [{ id: 'bot-1', name: 'Refreshed bot' }]
    })
  })
})

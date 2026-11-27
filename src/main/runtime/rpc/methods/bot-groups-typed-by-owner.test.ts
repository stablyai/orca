// Security invariant: a room post is stamped as typed by the owner (so its words may become a
// request's text) only from the host's own window; a paired device's declared account is a claim.
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { makeTestBot } from '../../../bots/bot.test-fixture'
import { runtimeBotGroups } from '../../../bots/bot-group-runtime'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import type { RpcCallerIdentity } from '../callers/rpc-caller-identity'
import type { RpcContext } from '../core'
import { BOT_GROUP_METHODS } from './bot-groups'

const HOST_ACCOUNT = 'account-owner'
const bot = makeTestBot()

let db: OrchestrationDb
beforeEach(() => {
  db = new OrchestrationDb(':memory:')
})
afterEach(() => {
  db.close()
})

/** The host, signed in to `hostAccount` (null: signed out, or `orca serve`), with one room. */
function hostWithRoom(hostAccount: string | null) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a host with only what a room post and its stamp read.
  const runtime = {
    getOrchestrationDb: () => db,
    bots: { assertEnabled: () => undefined, list: () => [bot] },
    notifyBotGroupsChanged: () => undefined,
    getConnectorCloud: () => ({ signedInAccount: () => hostAccount }),
    // A paired desktop's account is the one its connection declares.
    pairedDeviceAccount: (_deviceId: string, claim?: { id: string; name: string } | null) =>
      claim ?? null
  } as unknown as RpcContext['runtime']
  runtimeBotGroups(runtime).store.put({
    id: 'room-1',
    name: 'Release',
    hostId: 'local',
    revision: 1,
    folder: '/work/release',
    folderWorkspaceId: 'folder:release',
    createdAt: 0,
    members: [{ botId: bot.id, sessionId: 'bot-group-member-1' }],
    // No @mention in the posts below, so no member turn is started.
    replyMode: { kind: 'mentions' }
  })
  return runtime
}

const send = BOT_GROUP_METHODS.find((method) => method.name === 'bots.groups.send')!

/** Posts through the RPC handler and reads the stamp the stored room line kept. */
async function stampOf(
  runtime: RpcContext['runtime'],
  caller: RpcCallerIdentity,
  declared: string | null = null
): Promise<boolean | undefined> {
  const messageId = randomUUID()
  await send.handler(
    { groupId: 'room-1', revision: 1, messageId, text: 'Ship the release notes' },
    {
      runtime,
      caller,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stamp reads only the account the connection declared.
      deviceSelf: {
        orcaAccount: () => (declared ? { id: declared, name: 'Someone' } : null)
      } as RpcContext['deviceSelf']
    }
  )
  return runtimeBotGroups(runtime).store.message(messageId)?.typedByOwner
}

it("stamps a room post as the owner's only from the host's own window", async () => {
  const runtime = hostWithRoom(HOST_ACCOUNT)
  const device = { kind: 'paired-device', deviceId: 'device-1' } as const
  expect(await stampOf(runtime, { kind: 'desktop' })).toBe(true)
  // Declaring the host's account proves nothing (#48774), so even that device's post keeps no words.
  expect(await stampOf(runtime, device, HOST_ACCOUNT)).toBeUndefined()
  expect(await stampOf(runtime, device, 'account-other')).toBeUndefined()
  expect(await stampOf(runtime, device)).toBeUndefined()
  // The orca CLI over that device's pairing is an agent, not the person, whatever it declares.
  expect(await stampOf(runtime, { ...device, agent: true }, HOST_ACCOUNT)).toBeUndefined()
  // A host signed in to no account has nothing to compare with, so no device post is the owner's.
  expect(await stampOf(hostWithRoom(null), device, HOST_ACCOUNT)).toBeUndefined()
})

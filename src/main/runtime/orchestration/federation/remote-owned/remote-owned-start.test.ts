import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { ORCHESTRATION_CHAT_LINEAGE_RUNTIME_CAPABILITY } from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { startsInChatLineage } from '../../../rpc/methods/orchestration/worker/start/worker-chat-lineage'
import {
  forwardedChatLineage,
  serverStartOptions,
  startRemoteOwnedWorker
} from './remote-owned-start'

type Runtime = Parameters<typeof forwardedChatLineage>[0]
type Params = Parameters<typeof forwardedChatLineage>[2]
type Caller = Parameters<typeof forwardedChatLineage>[3]

const server = { environmentId: 'env-1', name: 'server', peerFingerprint: 'peer-1' }
// No --from: the creator resolves to none, so only the flag itself could make this a lineage.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lineage read and the option filter read only these fields.
const params = { spec: 'work', on: 'server', chatLineage: true } as Params

/** Reads the agent-home list and answers the server's status probe; nothing else of the runtime. */
function runtimeWith(serverCapabilities: string[]): Runtime {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lineage read and the capability probe use only these members.
  return {
    bots: { list: () => [{ folderWorkspaceId: 'home-1' }] },
    callOrchestrationWorkerServer: async () => ({
      runtimeId: 'server-runtime',
      capabilities: serverCapabilities
    })
  } as unknown as Runtime
}

function session(workspaceId: string): Caller {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: membership reads only the session's workspace.
  return { sessionId: 'session-1', workspaceId } as unknown as Caller
}

describe('a chat-lineage start on a paired server', () => {
  let db: OrchestrationDb
  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })
  afterEach(() => db.close())

  it('carries the lineage only to a server that takes it, and only for a lineage caller', async () => {
    const home = session('folder:home-1')
    const takes = runtimeWith([ORCHESTRATION_CHAT_LINEAGE_RUNTIME_CAPABILITY])
    expect(await forwardedChatLineage(takes, db, params, home, server)).toEqual({
      chatLineage: true
    })
    expect(await forwardedChatLineage(runtimeWith([]), db, params, home, server)).toEqual({})
    // A caller outside any lineage cannot claim one by sending the flag itself.
    const elsewhere = session('folder:elsewhere')
    expect(await forwardedChatLineage(takes, db, params, elsewhere, server)).toEqual({})
    expect(serverStartOptions(params)).not.toHaveProperty('chatLineage')
    expect(serverStartOptions(params)).toMatchObject({ spec: 'work' })
  })

  it('is honoured on the server only from the paired Orca coordinating the Run', () => {
    const runtime = runtimeWith([])
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the caller kind is read for a paired claim.
    const peer = { kind: 'peer' } as Caller
    const claim = { chatLineage: true } as const
    expect(startsInChatLineage(runtime, db, claim, peer)).toBe(true)
    expect(startsInChatLineage(runtime, db, claim, session('folder:elsewhere'))).toBe(false)
    expect(startsInChatLineage(runtime, db, {}, peer)).toBe(false)
  })

  it('rejects additionalDirectories when the paired server lacks the capability', async () => {
    const runtime = {
      getOrchestrationDb: () => db,
      getTerminalPaneKey: () => 'pane-1',
      getTerminalProcessIncarnation: () => undefined,
      getTerminalLookupScope: () => undefined,
      getOrchestrationDispatchAuthority: () => undefined,
      resolveOrchestrationWorkerServer: async () => server,
      callOrchestrationWorkerServer: async () => ({
        runtimeId: 'server-runtime',
        capabilities: []
      })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: startRemoteOwnedWorker only reaches capability probing with these members.
    } as unknown as Runtime
    const ctx = {
      runtime,
      orchestrationCaller: undefined
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: startRemoteOwnedWorker only reads runtime and orchestrationCaller.
    } as unknown as Parameters<typeof startRemoteOwnedWorker>[2]

    await expect(
      startRemoteOwnedWorker(
        runtime,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal start params for capability check.
        {
          spec: 'work',
          on: 'server',
          from: 'term_coord',
          additionalDirectories: ['/tmp/extra']
        } as Params,
        ctx,
        'req-1'
      )
    ).rejects.toMatchObject({
      code: 'capability_unsupported'
    })
  })
})

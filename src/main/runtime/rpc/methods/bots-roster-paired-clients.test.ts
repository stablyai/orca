import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { clientAskPullStarted } from '../../orchestration/federation/client-asks/client-ask-listeners'
import { RpcDispatcher } from '../dispatcher'
import { BOT_METHODS } from './bots'

describe("bots.roster's paired computers", () => {
  it("gives them to this Orca's own callers and never to a paired caller", async () => {
    const runtime = new OrcaRuntimeService(null)
    vi.spyOn(runtime.bots, 'roster').mockResolvedValue([])
    vi.spyOn(runtime, 'listOrchestrationWorkerServers').mockResolvedValue([])
    clientAskPullStarted(
      runtime,
      { deviceId: 'device_a', fingerprint: 'fp_a' },
      {
        session: 's',
        installationId: 'install_a',
        name: "Alice's Mac",
        bots: [{ id: 'docs', name: 'Docs' }]
      }
    )
    const roster = (context: Parameters<RpcDispatcher['dispatch']>[1]) =>
      new RpcDispatcher({ runtime, methods: BOT_METHODS })
        .dispatch(
          {
            id: 'roster',
            authToken: 'local',
            method: 'bots.roster',
            params: { allComputers: true }
          },
          context
        )
        .then((response) => (response.ok ? response.result : response.error))

    expect(await roster({ caller: { kind: 'desktop' } })).toMatchObject({
      clients: [
        { name: "Alice's Mac", onClient: 'install_a', bots: [{ id: 'docs', name: 'Docs' }] }
      ]
    })
    // A paired computer reading this Orca's roster gets only its bots, never itself back.
    expect(
      await roster({
        authenticatedCallerFingerprint: 'fp_a',
        pairedDeviceId: 'device_a',
        clientKind: 'runtime'
      })
    ).toEqual({ bots: [] })
  })
})

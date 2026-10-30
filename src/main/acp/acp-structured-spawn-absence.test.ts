import { afterEach, describe, expect, it } from 'vitest'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { providerStartupFailureFact } from '../native-chat/agent-session-wire/structured-agent-session-failure-text'
import { openAcpAdapterRig, type AcpAdapterRig } from './acp-structured-adapter.test-support'
import { AcpConnectionClosedError } from './acp-errors'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

/** The supervisor's exit after it could not spawn the agent's CLI. */
function spawnEnoent(rig: AcpAdapterRig): void {
  const child = rig.child()
  child.stderr = 'spawn grok ENOENT'
  child.spawnAbsence = 'executable'
  child.exit({ code: 127, signal: null, processless: false })
}

describe('an ACP CLI the supervisor could not spawn', () => {
  it('ends a start that exits during the handshake as a missing CLI', async () => {
    const rig = await openAcpAdapterRig({
      script: (agent) => agent.on('initialize', () => spawnEnoent(rig))
    })

    await rig.acquire()

    expect(rig.ended).toMatchObject([{ cause: 'unexpected-exit', failure: { kind: 'cliMissing' } }])
    expect(providerStartupFailureFact(rig.openFailure())).toMatchObject({ kind: 'cliMissing' })
  })

  it('refuses an acquisition the exit lands in as a missing CLI', async () => {
    const rig = await openAcpAdapterRig()

    const refused = await rig.acquire({ onSpawned: async () => spawnEnoent(rig) }).then(
      () => null,
      (error: unknown) => error
    )

    expect(refused).toBeInstanceOf(Error)
    expect(providerStartupFailureFact(refused)).toMatchObject({ kind: 'cliMissing' })
  })

  it('marks a start whose stream closed before the exit report, once its close proves the exit', async () => {
    // No grace: the exit lands only when the adapter's close proves it.
    const rig = await openAcpAdapterRig({ deps: { stopGraceMs: 0 } })

    const refused = await rig
      .acquire({
        onSpawned: async () => {
          rig.child().spawnAbsence = 'executable'
          throw new AcpConnectionClosedError('the agent closed its stream')
        }
      })
      .then(
        () => null,
        (error: unknown) => error
      )

    expect(rig.child().exited).toBe(true)
    expect(providerStartupFailureFact(refused)).toMatchObject({ kind: 'cliMissing' })
  })
})

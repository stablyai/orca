import { afterEach, describe, expect, it } from 'vitest'
import { withMissingProviderExecutable } from '../provider-process/provider-executable-missing'
import { providerStartupFailureFact } from '../native-chat/agent-session-wire/structured-agent-session-failure-text'
import {
  closePiRpcAdapterFixtures,
  reportedEvent,
  restart,
  setup
} from './rpc-session-adapter.test-fixture'

afterEach(closePiRpcAdapterFixtures)

describe('a Pi CLI the supervisor could not spawn', () => {
  it('ends the session as a missing CLI, not a provider exit', async () => {
    const h = await setup()

    h.connection.exit(
      withMissingProviderExecutable(new Error('Agent process exited (code 127, signal none)'))
    )
    await h.adapter.drainObservedExits()

    expect(reportedEvent(h.lifecycle, 'ended')).toMatchObject({
      cause: 'unexpected-exit',
      failure: { kind: 'cliMissing' }
    })
  })

  it('refuses the start as a missing CLI when it exits while acquiring', async () => {
    const h = await setup()

    const refused = await restart(h, (child) => {
      child.spawnAbsence = 'executable'
      child.closed = true
    }).then(
      () => null,
      (error: unknown) => error
    )

    expect(refused).toBeInstanceOf(Error)
    expect(providerStartupFailureFact(refused)).toMatchObject({ kind: 'cliMissing' })
  })
})

import { afterEach, expect, it } from 'vitest'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import {
  eventually,
  type RigSendOptions
} from './structured-agent-session-queued-message-rig-provider.test-fixture'
import { AgentSessionAcquisitionRefusal } from '../../providers/structured-agent-session-adapter-errors'
import type { StructuredAgentSessionHostDeps } from '../structured-agent-session-host-types'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION as SESSION
} from './structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig | undefined
afterEach(async () => rig?.dispose())

/** A send whose start the agent refused because it isn't signed in. */
async function refusedSend(
  text: string,
  options: {
    signedOutRetry?: StructuredAgentSessionHostDeps['signedOutRetry']
    send?: RigSendOptions
  } = {}
) {
  let clock = HOST_TEST_NOW
  rig = await createQueuedMessageTestRig({
    atRest: true,
    now: () => clock,
    ...(options.signedOutRetry ? { signedOutRetry: options.signedOutRetry } : {})
  })
  const current = rig
  current.failNextStart(new AgentSessionAcquisitionRefusal('Not logged in', 'notSignedIn'))
  const refused = current.send(text, undefined, options.send)
  await refused.result
  await eventually(async () =>
    expect((await current.submission(refused.id))?.dispatchState).toBe('rejected')
  )
  // The journal stamps the refusal with the real clock; the 30-minute window reads it.
  clock = (await current.submission(refused.id))!.resolvedAt! + 60_000
  const resent = async () => {
    const snapshot = await current.host.journalSnapshot(SESSION)
    return snapshot.submissions
      .filter((submission) => submission.clientMessageId !== refused.id)
      .map(
        (submission) =>
          snapshot.items.find((item) => item.itemId.endsWith(submission.clientMessageId))?.body
      )
  }
  return { current, refusedId: refused.id, resent }
}

it('re-sends a refused start once the account signs in, and a later Retry sends nothing more', async () => {
  let signedIn = false
  let accountsChanged = (): void => {}
  const { current, refusedId, resent } = await refusedSend('fix the build', {
    signedOutRetry: {
      launchAccountSignedIn: async () => signedIn,
      subscribe: (changed) => {
        accountsChanged = changed
        return () => {}
      }
    }
  })

  accountsChanged()
  await current.host.signedOutRetry.sweep()
  expect(await resent()).toEqual([])

  signedIn = true
  accountsChanged()
  await current.host.signedOutRetry.sweep()
  await eventually(async () =>
    expect(await resent()).toMatchObject([
      { kind: 'message', blocks: [{ type: 'text', text: 'fix the build' }] }
    ])
  )

  await expect(current.host.signedOutRetry.retry(SESSION, refusedId)).resolves.toEqual({
    outcome: 'superseded'
  })
  accountsChanged()
  await current.host.signedOutRetry.sweep()
  expect(await resent()).toHaveLength(1)
})

it('Retry re-sends a refused send that has no card once, and a second Retry sends nothing', async () => {
  const { current, refusedId, resent } = await refusedSend('run the nightly check', {
    send: { internal: true }
  })

  await expect(current.host.signedOutRetry.retry(SESSION, refusedId)).resolves.toEqual({
    outcome: 'sent'
  })
  await expect(current.host.signedOutRetry.retry(SESSION, refusedId)).resolves.toEqual({
    outcome: 'superseded'
  })
  expect(await resent()).toMatchObject([
    { kind: 'message', blocks: [{ type: 'text', text: 'run the nightly check' }] }
  ])
})

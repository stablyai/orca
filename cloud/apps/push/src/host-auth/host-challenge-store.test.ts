import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  answerPushHostChallenge,
  createPushHostKeypair,
  hostPublicKeyB64
} from './host-challenge-answering.test-fixture.js'
import { PushHostChallengeStore } from './host-challenge-store.js'

import { openInMemoryPushDatabase } from '../database/push-database.js'
import type { CloudDatabase as PushDatabase } from '@orca-cloud/cloud-database/cloud-database'

const GATEWAY_ORIGIN = 'https://push.onorca.dev'

describe('push host challenge store', () => {
  let database: PushDatabase
  let clock = 1_700_000_000_000
  let store: PushHostChallengeStore

  beforeEach(async () => {
    database = await openInMemoryPushDatabase()
    clock = 1_700_000_000_000
    store = new PushHostChallengeStore(database, GATEWAY_ORIGIN, () => clock)
  })

  afterEach(async () => {
    await database.close()
  })

  it('rejects a proof issued for another challenge', async () => {
    const owner = createPushHostKeypair(6)
    const intruder = createPushHostKeypair(7)
    const ownerChallenge = await store.issue(hostPublicKeyB64(owner))
    const intruderChallenge = await store.issue(hostPublicKeyB64(intruder))
    const intruderProof = answerPushHostChallenge(intruderChallenge!, {
      gatewayOrigin: GATEWAY_ORIGIN,
      keypair: intruder,
      now: () => clock
    })!
    await expect(store.verify(ownerChallenge!.challengeId, intruderProof)).resolves.toEqual({
      ok: false,
      reason: 'proof_mismatch'
    })
  })
})

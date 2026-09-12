import { expect, it } from 'vitest'
import { openInMemoryPushDatabase, openPushDatabase } from './push-database.js'
import { PushHostChallengeStore } from './host-challenge-store.js'
import {
  answerPushHostChallenge,
  createPushHostKeypair,
  hostPublicKeyB64
} from './host-challenge-answering.test-fixture.js'

it('accepts independent proofs but consumes each challenge only once under concurrency', async () => {
  const databaseUrl = process.env.ORCA_PUSH_TEST_DATABASE_URL
  if (databaseUrl && !process.env.CI && new URL(databaseUrl).port !== '55440') {
    throw new Error('isolated_postgres_port_required')
  }
  const db = databaseUrl
    ? await openPushDatabase({ databaseUrl, dataDir: '', poolMax: 4 })
    : await openInMemoryPushDatabase()
  const host = createPushHostKeypair()
  const origin = 'https://push.onorca.dev'
  const store = new PushHostChallengeStore(db, origin)
  const challenges = await Promise.all([
    store.issue(hostPublicKeyB64(host)),
    store.issue(hostPublicKeyB64(host))
  ])
  try {
    const proofs = challenges.map((challenge) =>
      answerPushHostChallenge(challenge!, { gatewayOrigin: origin, keypair: host })!
    )
    const results = await Promise.all(
      challenges.flatMap((challenge, index) =>
        Array.from({ length: 5 }, () => store.verify(challenge!.challengeId, proofs[index]!))
      )
    )
    expect(results.filter((result) => result.ok)).toEqual([
      { ok: true, hostFingerprint: challenges[0]!.hostFingerprint },
      { ok: true, hostFingerprint: challenges[0]!.hostFingerprint }
    ])
    expect(results.filter((result) => !result.ok)).toEqual(
      Array.from({ length: 8 }, () => ({ ok: false, reason: 'already_consumed' }))
    )
  } finally {
    for (const challenge of challenges) {
      await db.query('DELETE FROM push_challenges WHERE challenge_id = ?', [challenge!.challengeId])
    }
    await db.close()
  }
})

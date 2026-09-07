import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseRelayLoadArguments,
  relayLoadPrincipalIndex,
  relayLoadReaderEvidenceError,
  relayLoadSpliceIndexes,
  relayLoadSpliceProfile,
  relayLoadSpliceStartDelayMs
} from './relay-load-profile.mjs'

const required = ['--auth-origin', 'https://auth.test', '--director-origin', 'https://relay.test']

test('accepts the 2840-control two-lease-horizon Asia proof profile', () => {
  const config = parseRelayLoadArguments([
    ...required,
    '--controls',
    '2840',
    '--duration-seconds',
    '210',
    '--required-lease-horizons',
    '2',
    '--preferred-region',
    'asia-east2',
    '--relay-asia-load-principals',
    '32',
    '--capacity-hard-cap',
    '3000'
  ])

  assert.equal(config.controls, 2840)
  assert.equal(config.durationMs, 210_000)
  assert.equal(config.requiredLeaseHorizons, 2)
  assert.equal(config.preferredRegion, 'asia-east2')
  assert.equal(config.relayAsiaLoadPrincipalCount, 32)
  assert.equal(config.splices, 0)
})

test('binds synthetic Relay principals to a bounded Asia director proof', () => {
  assert.throws(() => parseRelayLoadArguments([
    ...required, '--relay-asia-load-principals', '1'
  ]), /require a regional director proof/)
  assert.throws(() => parseRelayLoadArguments([
    ...required, '--preferred-region', 'asia-east2',
    '--relay-asia-load-principals', '33'
  ]), /require a regional director proof/)
})

test('rejects a mixed profile beyond the ordinary 2900-unit boundary', () => {
  assert.throws(
    () => parseRelayLoadArguments([
      ...required,
      '--controls', '2840',
      '--splices', '31',
      '--capacity-hard-cap', '3000'
    ]),
    /exceed ordinary cell admission/
  )
  expectMixedProfile(parseRelayLoadArguments([
    ...required,
    '--controls', '2600',
    '--splices', '120',
    '--capacity-hard-cap', '3000'
  ]))
})

test('requires reviewed aggregate totals for capacity-bound shards', () => {
  assert.throws(
    () => parseRelayLoadArguments([
      ...required, '--controls', '2840', '--capacity-hard-cap', '3000',
      '--shard-count', '4', '--shard-index', '0'
    ]),
    /requires explicit aggregate controls and splices/
  )
  assert.throws(
    () => parseRelayLoadArguments([
      ...required, '--controls', '2840', '--capacity-hard-cap', '3000',
      '--shard-count', '4', '--shard-index', '0',
      '--aggregate-controls', '2840', '--aggregate-splices', '0'
    ]),
    /must match every equal-sized shard/
  )
  const config = parseRelayLoadArguments([
    ...required, '--controls', '710', '--capacity-hard-cap', '3000',
    '--shard-count', '4', '--shard-index', '0',
    '--aggregate-controls', '2840', '--aggregate-splices', '0'
  ])
  assert.equal(config.aggregateControls, 2840)
  assert.equal(config.aggregateSplices, 0)
})

test('allows one coordinating shard to prove regional fallback', () => {
  const config = parseRelayLoadArguments([
    ...required, '--controls', '710', '--capacity-hard-cap', '3000',
    '--shard-count', '4', '--shard-index', '0',
    '--aggregate-controls', '2840', '--aggregate-splices', '0',
    '--regional-fallback-probes', '1', '--capacity-cell-id', 'staging-gce-c4',
    '--capacity-cell-origin', 'https://c4.relay-staging.onorca.dev',
    '--capacity-unobserved-bound', '60', '--rebind-probes', '160'
  ])
  assert.equal(config.regionalFallbackProbes, 1)
  assert.equal(config.capacityCellOrigin, 'https://c4.relay-staging.onorca.dev')
  assert.throws(() => parseRelayLoadArguments([
    ...required, '--controls', '710', '--capacity-hard-cap', '3000',
    '--shard-count', '4', '--shard-index', '1',
    '--aggregate-controls', '2840', '--aggregate-splices', '0',
    '--regional-fallback-probes', '1', '--capacity-cell-id', 'staging-gce-c4',
    '--capacity-cell-origin', 'https://c4.relay-staging.onorca.dev',
    '--capacity-unobserved-bound', '60'
  ]), /coordinating capacity shard/)
})

test('accepts the exact sharded request-unit and region behavior proof', () => {
  const config = parseRelayLoadArguments([
    ...required, '--preferred-region', 'asia-east2',
    '--controls', '710', '--capacity-hard-cap', '3000',
    '--shard-count', '4', '--shard-index', '0',
    '--aggregate-controls', '2840', '--aggregate-splices', '0',
    '--capacity-cell-id', 'staging-gce-c4',
    '--capacity-cell-origin', 'https://c4.relay-staging.onorca.dev',
    '--request-unit-invites', '790', '--request-unit-invites-per-second', '2',
    '--request-unit-principals', '32',
    '--aggregate-request-unit-invites', '3160',
    '--request-unit-capacity', '6000', '--request-unit-overflow-probes', '1',
    '--request-unit-cleanup-timeout-seconds', '630',
    '--region-behavior-probes', '1', '--phase-barrier-dir', '/tmp/load-barrier'
  ])
  assert.equal(config.aggregateRequestUnitInvites, 3_160)
  assert.equal(config.requestUnitCapacity, 6_000)
  assert.equal(config.requestUnitPrincipalCount, 32)
  assert.equal(config.requestUnitCleanupTimeoutMs, 630_000)
  assert.equal(config.regionBehaviorProbes, 1)
  assert.equal(config.phaseBarrierDir, '/tmp/load-barrier')

  assert.throws(() => parseRelayLoadArguments([
    ...required, '--controls', '710', '--capacity-hard-cap', '3000',
    '--shard-count', '4', '--shard-index', '0',
    '--aggregate-controls', '2840', '--aggregate-splices', '0',
    '--capacity-cell-id', 'staging-gce-c4', '--request-unit-invites', '789',
    '--request-unit-invites-per-second', '2',
    '--request-unit-principals', '32',
    '--aggregate-request-unit-invites', '3156', '--request-unit-capacity', '6000',
    '--phase-barrier-dir', '/tmp/load-barrier'
  ]), /does not reach the exact reviewed capacity/)

  assert.throws(() => parseRelayLoadArguments([
    ...required, '--controls', '710', '--capacity-hard-cap', '3000',
    '--shard-count', '4', '--shard-index', '0',
    '--aggregate-controls', '2840', '--aggregate-splices', '0',
    '--capacity-cell-id', 'staging-gce-c4', '--request-unit-invites', '790',
    '--request-unit-invites-per-second', '2', '--request-unit-principals', '26',
    '--aggregate-request-unit-invites', '3160', '--request-unit-capacity', '6000',
    '--phase-barrier-dir', '/tmp/load-barrier'
  ]), /does not reach the exact reviewed capacity/)
})

function expectMixedProfile(config) {
  assert.equal(config.controls + 2 * config.splices, 2840)
}

test('rejects a run shorter than its required lease horizons', () => {
  assert.throws(
    () =>
      parseRelayLoadArguments([
        ...required,
        '--duration-seconds',
        '209',
        '--required-lease-horizons',
        '2'
      ]),
    /must cover 2 lease horizons/
  )
})

test('bounds an explicit splice hold within the steady window', () => {
  const config = parseRelayLoadArguments([
    ...required,
    '--controls', '1',
    '--splices', '1',
    '--duration-seconds', '300',
    '--splice-hold-seconds', '60'
  ])
  assert.equal(config.durationMs, 300_000)
  assert.equal(config.spliceHoldMs, 60_000)
  assert.throws(() => parseRelayLoadArguments([
    ...required,
    '--controls', '1',
    '--splices', '1',
    '--duration-seconds', '300',
    '--splice-hold-seconds', '301'
  ]), /between 1 and the steady duration/)
})

test('maps splice ownership deterministically within a shard', () => {
  const config = parseRelayLoadArguments([
    ...required,
    '--controls',
    '4',
    '--splices',
    '3',
    '--shard-count',
    '4',
    '--shard-index',
    '2'
  ])

  assert.deepEqual(relayLoadSpliceIndexes(config), [2, 6, 10])
})

test('staggered shards form one deterministic splice ramp', () => {
  const config = parseRelayLoadArguments([
    ...required,
    '--controls', '4',
    '--splices', '3',
    '--splice-ramp-seconds', '11',
    '--shard-count', '4',
    '--shard-index', '2'
  ])

  assert.equal(config.spliceRampMs, 11_000)
  assert.deepEqual(
    [0, 1, 2].map((index) => relayLoadSpliceStartDelayMs(config, index)),
    [2_000, 6_000, 10_000]
  )
  assert.throws(() => relayLoadSpliceStartDelayMs(config, 3), /invalid local splice index/)
})

test('distributes each shard invite wave below the account rate limit', () => {
  const identities = Array.from(
    { length: 710 },
    (_, localIndex) => relayLoadPrincipalIndex(localIndex * 4 + 2, 4, 32)
  )
  const offers = Array.from({ length: 790 }, (_, index) => identities[index % identities.length])
  const counts = new Map()
  for (const principal of offers) counts.set(principal, (counts.get(principal) ?? 0) + 1)
  assert.equal(counts.size, 32)
  assert.equal(Math.max(...counts.values()), 26)
})

test('requires exactly one assignment mode', () => {
  assert.throws(
    () =>
      parseRelayLoadArguments([
        ...required,
        '--target-origin',
        'https://cell.test'
      ]),
    /exactly one target or director origin/
  )
})

test('requires separate recoverable and wedged reader profiles', () => {
  const config = parseRelayLoadArguments([
    ...required,
    '--controls', '4',
    '--splices', '3',
    '--slow-reader-splices', '1',
    '--wedged-reader-splices', '1',
    '--slow-reader-stream-bytes', '524288',
    '--wedged-reader-stream-bytes', '1048576',
    '--slow-reader-hold-ms', '9000',
    '--wedged-reader-hold-ms', '11000'
  ])

  assert.deepEqual(relayLoadSpliceProfile(config, 0), {
    readerMode: 'wedged', readerHoldMs: 11_000, streamBytes: 1_048_576, frameBytes: 65_536
  })
  assert.deepEqual(relayLoadSpliceProfile(config, 1), {
    readerMode: 'slow', readerHoldMs: 9_000, streamBytes: 524_288, frameBytes: 65_536
  })
  assert.equal(relayLoadSpliceProfile(config, 2).readerMode, 'normal')
})

test('bounds reader stream, timeout, and splice load per shard', () => {
  assert.throws(
    () => parseRelayLoadArguments([...required, '--controls', '2', '--splices', '3']),
    /splices cannot exceed/
  )
  assert.throws(
    () =>
      parseRelayLoadArguments([
        ...required,
        '--splices',
        '1',
        '--slow-reader-splices',
        '2'
      ]),
    /reader splice counts cannot exceed/
  )
  assert.throws(
    () => parseRelayLoadArguments([
      ...required, '--splices', '1', '--slow-reader-splices', '1',
      '--slow-reader-stream-bytes', '262144'
    ]),
    /must exceed the 256 KiB/
  )
  assert.throws(
    () => parseRelayLoadArguments([
      ...required, '--splices', '1', '--wedged-reader-splices', '1',
      '--wedged-reader-stream-bytes', '262144'
    ]),
    /must exceed the 256 KiB/
  )
  assert.throws(
    () => parseRelayLoadArguments([
      ...required, '--splices', '1', '--slow-reader-splices', '1',
      '--slow-reader-hold-ms', '10000'
    ]),
    /must stay below the wedged timeout/
  )
  assert.throws(
    () => parseRelayLoadArguments([
      ...required, '--splices', '1', '--wedged-reader-splices', '1',
      '--wedged-reader-hold-ms', '10000'
    ]),
    /must exceed the wedged timeout/
  )
  assert.throws(
    () => parseRelayLoadArguments([
      ...required, '--controls', '17', '--splices', '17', '--slow-reader-splices', '17'
    ]),
    /reader splice count exceeds/
  )
  assert.throws(
    () => parseRelayLoadArguments([
      ...required, '--controls', '9', '--splices', '9', '--wedged-reader-splices', '9'
    ]),
    /reader stream bytes exceed/
  )
})

test('supports one bounded reader-owning shard without multiplying its pressure', () => {
  const owner = parseRelayLoadArguments([
    ...required,
    '--controls', '650', '--splices', '30', '--capacity-hard-cap', '3000',
    '--shard-count', '4', '--shard-index', '0',
    '--aggregate-controls', '2600', '--aggregate-splices', '120',
    '--slow-reader-splices', '10', '--wedged-reader-splices', '1',
    '--aggregate-reader-splices', '11', '--aggregate-reader-bytes', '18874368'
  ])
  const peer = parseRelayLoadArguments([
    ...required,
    '--controls', '650', '--splices', '30', '--capacity-hard-cap', '3000',
    '--shard-count', '4', '--shard-index', '1',
    '--aggregate-controls', '2600', '--aggregate-splices', '120',
    '--aggregate-reader-splices', '11', '--aggregate-reader-bytes', '18874368'
  ])

  assert.equal(owner.aggregateReaderSplices, 11)
  assert.equal(owner.aggregateReaderBytes, 18 * 1024 * 1024)
  assert.equal(peer.slowReaderSplices + peer.wedgedReaderSplices, 0)
  assert.equal(peer.aggregateReaderSplices, 11)
})

test('requires queue, memory, and expected close evidence', () => {
  const config = parseRelayLoadArguments([
    ...required, '--splices', '2', '--slow-reader-splices', '1',
    '--wedged-reader-splices', '1', '--max-generator-rss-growth-mib', '100'
  ])
  const passing = {
    generatorRssGrowthMiB: 50,
    slowReaderSplicesCompleted: 1,
    wedgedReaderSplicesClosed: 1,
    readerQueueEvidence: [
      { origin: 'https://cell.test', baselineBytes: 8, peakBytes: 65_544, increaseBytes: 65_536 }
    ],
    readerClosesByCode: { '4429': 1 }
  }

  assert.equal(relayLoadReaderEvidenceError(passing, config), undefined)
  assert.match(
    relayLoadReaderEvidenceError({
      ...passing,
      readerQueueEvidence: [
        { origin: 'https://cell.test', baselineBytes: 8, peakBytes: 8, increaseBytes: 0 }
      ]
    }, config),
    /no causal Relay queued-byte evidence/
  )
  assert.match(
    relayLoadReaderEvidenceError({ ...passing, generatorRssGrowthMiB: 101 }, config),
    /RSS growth budget/
  )
  assert.match(
    relayLoadReaderEvidenceError({ ...passing, readerClosesByCode: { '4429': 0 } }, config),
    /did not close with 4429/
  )
})

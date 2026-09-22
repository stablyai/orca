import assert from 'node:assert/strict'
import test from 'node:test'
import {
  proveRelayLoadRebindBoundary,
  waitForRelayLoadRebindGate
} from './relay-load-rebind-boundary.mjs'

function peer(open) {
  return { openRebindProbe: open }
}

function probe(onClose = () => undefined) {
  let open = true
  let resolveClosed
  const closed = new Promise((resolve) => {
    resolveClosed = resolve
  })
  return {
    close: () => {
      if (!open) return
      open = false
      onClose()
      resolveClosed()
    },
    closed,
    isOpen: () => open
  }
}

test('holds the requested rebind overlap and requires a hard-cap rejection', async () => {
  let openCalls = 0
  let closes = 0
  let heldFor = null
  const peers = [
    peer(async () => {
      openCalls++
      if (openCalls === 3) throw new Error('Unexpected server response: 503')
      return probe(() => closes++)
    }),
    peer(async () => {
      openCalls++
      return probe(() => closes++)
    })
  ]
  const result = await proveRelayLoadRebindBoundary({
    peers,
    probeCount: 2,
    holdMs: 4_000,
    delay: async (milliseconds) => {
      heldFor = milliseconds
    },
    failureReason: (error) =>
      error.message.includes('503') ? 'socket_http_503' : 'unknown'
  })

  assert.deepEqual(result, { opened: 2, overflowReason: 'socket_http_503' })
  assert.equal(heldFor, 4_000)
  assert.equal(closes, 2)
})

test('closes successful probes when a boundary probe fails', async () => {
  let closes = 0
  const peers = [
    peer(async () => probe(() => closes++)),
    peer(async () => {
      throw new Error('probe failed')
    })
  ]

  await assert.rejects(
    proveRelayLoadRebindBoundary({
      peers,
      probeCount: 2,
      holdMs: 0,
      delay: async () => undefined,
      failureReason: () => 'unknown'
    }),
    /probe failed/
  )
  assert.equal(closes, 1)
})

test('waits for every replacement socket to finish closing', async () => {
  let finishClose
  const closeFinished = new Promise((resolve) => {
    finishClose = resolve
  })
  const closingProbe = probe()
  closingProbe.close = () => closeFinished
  let completed = false
  const boundary = proveRelayLoadRebindBoundary({
    peers: [peer(async () => closingProbe)],
    probeCount: 1,
    holdMs: 0,
    delay: async () => undefined,
    failureReason: () => 'unknown',
    requireOverflow: false
  }).then(() => {
    completed = true
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(completed, false)
  finishClose()
  await boundary
  assert.equal(completed, true)
})

test('can prove reserved replacement headroom below the physical cap', async () => {
  let closes = 0
  const result = await proveRelayLoadRebindBoundary({
    peers: [peer(async () => probe(() => closes++))],
    probeCount: 1,
    holdMs: 0,
    delay: async () => undefined,
    failureReason: () => 'unknown',
    requireOverflow: false
  })
  assert.deepEqual(result, { opened: 1, overflowReason: null })
  assert.equal(closes, 1)
})

test('fails when a replacement closes before the hold completes', async () => {
  let heldProbe
  await assert.rejects(
    proveRelayLoadRebindBoundary({
      peers: [
        peer(async () => {
          heldProbe = probe()
          return heldProbe
        })
      ],
      probeCount: 1,
      holdMs: 4_000,
      delay: async () => {
        heldProbe.close()
      },
      failureReason: () => 'unknown',
      requireOverflow: false
    }),
    /closed before the hold completed/
  )
})

test('delays the boundary until every ordinary control has recovered', async () => {
  let active = 899
  await assert.rejects(
    waitForRelayLoadRebindGate({
      delay: async () => undefined,
      delayMs: 0,
      activeCount: () => active,
      requiredCount: 900
    }),
    /requires 900 active controls/
  )
  await waitForRelayLoadRebindGate({
    delay: async () => {
      active = 900
    },
    delayMs: 1,
    activeCount: () => active,
    requiredCount: 900
  })
})

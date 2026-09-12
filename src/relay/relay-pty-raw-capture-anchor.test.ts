import { expect, it } from 'vitest'
import { identity } from './relay-pty-ownership-transfer-delegation-test-fixture'
import { parseRelayPtyRawCaptureAnchors } from './relay-pty-raw-capture-anchor'
import { MAX_ISSUED_CAPTURE_BOUNDARIES } from './relay-pty-ownership-transfer-capture-journal'

const boundary = {
  version: 1 as const,
  identity,
  throughSeq: 3,
  delivery: {
    id: identity.terminalId,
    ptyIncarnation: identity.incarnationId,
    ownerGeneration: identity.sourceOwnerGeneration,
    providerGeneration: 1,
    clientGeneration: 2,
    deliveryToken: 'source-delivery',
    state: 'active' as const,
    windowSu: 256,
    receivedEndSu: 20,
    sentEndSu: 20,
    creditedEndSu: 20,
    generationClosed: false as const,
    exitPublished: false as const
  }
}
const anchor = { boundary, rawOriginSu: 100, rawEndSu: 112 }
const parse = (value: unknown) => parseRelayPtyRawCaptureAnchors(value, identity, [boundary])

it('rebuilds immutable anchors without conflating raw and delivery counters', () => {
  const input = structuredClone([anchor])
  const result = parse(input)!
  expect(result).toEqual([anchor])
  input[0].rawEndSu = 200
  input[0].boundary.delivery.deliveryToken = 'changed'
  expect(result).toEqual([anchor])
  expect(Object.isFrozen(result)).toBe(true)
  expect(Object.isFrozen(result[0])).toBe(true)
  expect(Object.isFrozen(result[0].boundary.delivery)).toBe(true)
})

it('accepts an exact selected baseline without an issued list', () => {
  expect(
    parseRelayPtyRawCaptureAnchors([anchor], identity, undefined, {
      version: 1,
      boundary,
      modelSha256: 'a'.repeat(64)
    })
  ).toEqual([anchor])
})

it('preserves absent legacy evidence and empty arrays', () => {
  expect(parse(undefined)).toBeUndefined()
  expect(parse([])).toEqual([])
})

it.each([null, {}, 'anchor', [null], [{}]])('rejects malformed records %#', (value) => {
  expect(() => parse(value)).toThrow()
})

it.each([
  { rawOriginSu: -1 },
  { rawEndSu: -1 },
  { rawOriginSu: 113 },
  { rawOriginSu: 0.5 },
  { rawEndSu: Number.MAX_SAFE_INTEGER + 1 },
  { rawEndSu: Infinity },
  { rawEndSu: '112' },
  { rawOriginSu: undefined }
])('rejects invalid raw counters %#', (patch) => {
  expect(() => parse([{ ...anchor, ...patch }])).toThrow()
})

it('rejects copied identities and boundaries not issued by this transfer', () => {
  expect(() =>
    parseRelayPtyRawCaptureAnchors(
      [anchor],
      {
        ...identity,
        bridgeId: 'other'
      },
      [boundary]
    )
  ).toThrow()
  expect(() => parseRelayPtyRawCaptureAnchors([anchor], identity)).toThrow()
  expect(() => parse([{ ...anchor, boundary: { ...boundary, throughSeq: 4 } }])).toThrow()
  expect(() =>
    parse([
      {
        ...anchor,
        boundary: {
          ...boundary,
          delivery: { ...boundary.delivery, deliveryToken: 'other' }
        }
      }
    ])
  ).toThrow()
})

it('rejects duplicate canonical boundaries even with different counters or property order', () => {
  expect(() => parse([anchor, { ...anchor, rawEndSu: 113 }])).toThrow()
  expect(() =>
    parse([
      anchor,
      {
        ...anchor,
        boundary: {
          delivery: boundary.delivery,
          throughSeq: boundary.throughSeq,
          identity: boundary.identity,
          version: boundary.version
        }
      }
    ])
  ).toThrow()
})

it('bounds durable anchor growth', () => {
  expect(() =>
    parse(Array.from({ length: MAX_ISSUED_CAPTURE_BOUNDARIES + 1 }, () => anchor))
  ).toThrow()
})

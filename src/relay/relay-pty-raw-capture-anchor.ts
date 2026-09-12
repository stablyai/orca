import {
  parsePtyOwnershipCaptureBoundary,
  type PtyOwnershipCaptureBoundary
} from '../shared/pty-ownership-capture-boundary'
import type { PtyOwnershipCaptureBaseline } from '../shared/pty-ownership-capture-baseline'
import type { PtyOwnershipTransferWireIdentity } from '../shared/pty-ownership-transfer-wire'
import { MAX_ISSUED_CAPTURE_BOUNDARIES } from './relay-pty-ownership-transfer-capture-journal'
import {
  invalidJournal,
  requireRecord,
  sequence
} from './relay-pty-ownership-transfer-journal-record-validation'

export type RelayPtyRawCaptureAnchor = Readonly<{
  boundary: PtyOwnershipCaptureBoundary
  rawOriginSu: number
  rawEndSu: number
}>

export function parseRelayPtyRawCaptureAnchors(
  value: unknown,
  identity: PtyOwnershipTransferWireIdentity,
  issuedCaptureBoundaries?: readonly PtyOwnershipCaptureBoundary[],
  captureBaseline?: PtyOwnershipCaptureBaseline
): readonly RelayPtyRawCaptureAnchor[] | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || value.length > MAX_ISSUED_CAPTURE_BOUNDARIES) {
    throw invalidJournal()
  }
  const issued = new Set(
    [
      ...(issuedCaptureBoundaries ?? []),
      ...(captureBaseline ? [captureBaseline.boundary] : [])
    ].map((boundary) => JSON.stringify(parsePtyOwnershipCaptureBoundary(boundary, identity)))
  )
  const seen = new Set<string>()
  return Object.freeze(
    value.map((entry) => {
      const record = requireRecord(entry)
      const boundary = parsePtyOwnershipCaptureBoundary(record.boundary, identity)
      const rawOriginSu = sequence(record.rawOriginSu)
      const rawEndSu = sequence(record.rawEndSu)
      const key = JSON.stringify(boundary)
      if (rawOriginSu > rawEndSu || !issued.has(key) || seen.has(key)) {
        throw invalidJournal()
      }
      seen.add(key)
      return Object.freeze({ boundary, rawOriginSu, rawEndSu })
    })
  )
}

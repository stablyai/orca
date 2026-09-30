import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import type WebSocket from 'ws'
import { RelayConnectionLedger } from './relay-connection-ledger.js'

function socket(): { webSocket: WebSocket; close: () => void } {
  const emitter = new EventEmitter()
  return {
    webSocket: emitter as WebSocket,
    close: () => emitter.emit('close')
  }
}

describe('RelayConnectionLedger', () => {
  it('orders connection admissions before covering absolute snapshots', () => {
    const ledger = new RelayConnectionLedger(6, 2)
    const upgrade = ledger.tryReserveControl(false)!
    const beforePromotion = ledger.snapshot()
    const controlSocket = socket()
    upgrade.promote(controlSocket.webSocket)
    const afterPromotion = ledger.snapshot()

    expect(beforePromotion.inclusionWatermark).toBeGreaterThanOrEqual(
      upgrade.inclusionWatermark
    )
    expect(afterPromotion.inclusionWatermark).toBeGreaterThan(
      beforePromotion.inclusionWatermark
    )
    expect(afterPromotion).toMatchObject({
      physicalConnections: 1,
      inFlightConnections: 0,
      enforcedConnectionUnits: 1
    })
  })

  it.each([600, 1_000, 3_000])(
    'enforces the %i-unit boundary with 100 control units reserved',
    (hardCap) => {
      const ledger = new RelayConnectionLedger(hardCap, 100)
      const sockets: Array<{ webSocket: WebSocket; close: () => void }> = []
      for (let index = 0; index < (hardCap - 100) / 2; index++) {
        const admission = ledger.tryReservePhone()
        expect(admission).not.toBeNull()
        const phoneSocket = socket()
        admission!.upgrade.promote(phoneSocket.webSocket)
        admission!.hostData.bind(`connection-${index}`)
        sockets.push(phoneSocket)
      }
      expect(ledger.tryReservePhone()).toBeNull()
      expect(ledger.tryReserveControl(false)).toBeNull()
      for (let index = 0; index < 100; index++) {
        const upgrade = ledger.tryReserveControl(true)
        expect(upgrade).not.toBeNull()
        const controlSocket = socket()
        upgrade!.promote(controlSocket.webSocket)
        sockets.push(controlSocket)
      }

      expect(ledger.counts().enforcedConnectionUnits).toBe(hardCap)
      expect(ledger.tryReserveControl(true)).toBeNull()
      sockets.at(-1)!.close()
      const replacement = ledger.tryReserveControl(true)
      expect(replacement).not.toBeNull()
      replacement!.release()
    }
  )

  it('reserves both phone legs below the control reserve', () => {
    const ledger = new RelayConnectionLedger(6, 2)
    const first = ledger.tryReservePhone()
    const second = ledger.tryReservePhone()

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(ledger.tryReservePhone()).toBeNull()
    expect(ledger.counts()).toEqual({
      physicalConnections: 0,
      inFlightConnections: 2,
      reservedConnectionUnits: 2,
      enforcedConnectionUnits: 4
    })
    expect(ledger.tryReserveControl(false)).toBeNull()
    expect(ledger.tryReserveControl(true)).not.toBeNull()
    expect(ledger.tryReserveControl(true)).not.toBeNull()
    expect(ledger.tryReserveControl(true)).toBeNull()
  })

  it('transfers a pending host-data unit without increasing enforced capacity', () => {
    const ledger = new RelayConnectionLedger(6, 2)
    const phone = ledger.tryReservePhone()!
    const phoneSocket = socket()
    phone.upgrade.promote(phoneSocket.webSocket)
    phone.hostData.bind('connection-1')

    const data = ledger.tryReserveHostData('connection-1')!
    expect(ledger.counts().enforcedConnectionUnits).toBe(2)
    const dataSocket = socket()
    data.promote(dataSocket.webSocket)
    expect(ledger.counts().enforcedConnectionUnits).toBe(2)
    expect(data.commitHostData()).toBe(true)

    dataSocket.close()
    dataSocket.close()
    expect(ledger.counts()).toEqual({
      physicalConnections: 1,
      inFlightConnections: 0,
      reservedConnectionUnits: 0,
      enforcedConnectionUnits: 1
    })
  })

  it('restores a claimed reservation after rejected host-data authentication', () => {
    const ledger = new RelayConnectionLedger(6, 2)
    const phone = ledger.tryReservePhone()!
    const phoneSocket = socket()
    phone.upgrade.promote(phoneSocket.webSocket)
    phone.hostData.bind('connection-1')

    const rejected = ledger.tryReserveHostData('connection-1')!
    const rejectedSocket = socket()
    rejected.promote(rejectedSocket.webSocket)
    rejectedSocket.close()

    expect(ledger.counts()).toEqual({
      physicalConnections: 1,
      inFlightConnections: 0,
      reservedConnectionUnits: 1,
      enforcedConnectionUnits: 2
    })
    expect(ledger.tryReserveHostData('connection-1')).not.toBeNull()
  })

  it('does not restore a claimed reservation after the phone closes', () => {
    const ledger = new RelayConnectionLedger(6, 2)
    const phone = ledger.tryReservePhone()!
    const phoneSocket = socket()
    phone.upgrade.promote(phoneSocket.webSocket)
    phone.hostData.bind('connection-1')
    const data = ledger.tryReserveHostData('connection-1')!
    const dataSocket = socket()
    data.promote(dataSocket.webSocket)

    phone.hostData.release()
    phoneSocket.close()
    dataSocket.close()

    expect(ledger.counts()).toEqual({
      physicalConnections: 0,
      inFlightConnections: 0,
      reservedConnectionUnits: 0,
      enforcedConnectionUnits: 0
    })
    expect(ledger.tryReserveHostData('connection-1')).not.toBeNull()
  })

  it('releases failed in-flight upgrades exactly once', () => {
    const ledger = new RelayConnectionLedger(6, 2)
    const phone = ledger.tryReservePhone()!

    phone.upgrade.release()
    phone.upgrade.release()
    phone.hostData.release()
    phone.hostData.release()

    expect(ledger.counts()).toEqual({
      physicalConnections: 0,
      inFlightConnections: 0,
      reservedConnectionUnits: 0,
      enforcedConnectionUnits: 0
    })
  })
})

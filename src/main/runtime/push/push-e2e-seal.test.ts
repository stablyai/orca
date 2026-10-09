import { describe, expect, it } from 'vitest'
import type { PushSendNotification } from './push-gateway-client'
import {
  derivePushSealKey,
  opaquePushNotificationEpoch,
  opaquePushNotificationId,
  sealPushNotification
} from './push-e2e-seal'
import { openSealedPushNotification } from './push-e2e-seal.test-fixture'

const TOKEN = 'a'.repeat(48)

// Mirrors PushNotificationSchema in cloud/packages/push-contract/src/send-messages.ts.
function expectWithinGatewayLimits(wire: PushSendNotification): void {
  expect(wire.paneKey!.length).toBeLessThanOrEqual(2048)
  expect(wire.notificationEpoch.length).toBeLessThanOrEqual(128)
  expect(wire.notificationId ?? 'x').toMatch(/^[\x20-\x7e]{1,2048}$/)
  expect(new TextEncoder().encode(JSON.stringify(wire)).byteLength).toBeLessThanOrEqual(3000)
}

function alert(overrides: Partial<PushSendNotification> = {}): PushSendNotification {
  return {
    notificationSeq: 3,
    notificationEpoch: 'epoch',
    notificationId: 'agent:repo%3A%3A%2Fhome%2Fme%2Fsecret-project:pane:1',
    source: 'agent-task-complete',
    agentState: 'needs-input',
    title: 'secret-project - Claude needs input',
    body: 'Using Bash: curl -H "Authorization: Bearer sk-live-123"',
    worktreeId: 'repo::/home/me/secret-project',
    ...overrides
  }
}

describe('sealPushNotification', () => {
  it('round-trips through the phone side and leaves only generic text on the wire', () => {
    const wire = sealPushNotification(alert(), TOKEN)

    expect(wire).toMatchObject({ title: 'Agent needs input', body: '' })
    expect(wire.worktreeId).toBeUndefined()
    expect(JSON.stringify(wire)).not.toMatch(/secret-project|sk-live|Bearer/)
    expectWithinGatewayLimits(wire)
    expect(openSealedPushNotification(wire, TOKEN)).toMatchObject({
      title: 'secret-project - Claude needs input',
      body: 'Using Bash: curl -H "Authorization: Bearer sk-live-123"',
      worktreeId: 'repo::/home/me/secret-project',
      notificationId: alert().notificationId,
      notificationEpoch: 'epoch'
    })
  })

  it('refuses to open with another device token', () => {
    const wire = sealPushNotification(alert(), TOKEN)
    expect(() => openSealedPushNotification(wire, 'b'.repeat(48))).toThrow()
  })

  it('uses a fresh nonce per send but stable opaque ids for dismissal matching', () => {
    const key = derivePushSealKey(TOKEN)
    const first = sealPushNotification(alert(), TOKEN)
    const second = sealPushNotification(alert({ kind: 'dismiss', notificationSeq: 4 }), TOKEN)
    expect(first.paneKey).not.toBe(second.paneKey)
    expect(second.notificationId).toBe(first.notificationId)
    expect(second.notificationEpoch).toBe(first.notificationEpoch)
    expect(first.notificationId).toBe(opaquePushNotificationId(key, alert().notificationId!))
    expect(first.notificationEpoch).toBe(opaquePushNotificationEpoch(key, 'epoch'))
    expectWithinGatewayLimits(second)
  })

  it('gives each phone its own event identity so the gateway accepts every copy', () => {
    const mine = sealPushNotification(alert(), TOKEN)
    const theirs = sealPushNotification(alert(), 'b'.repeat(48))
    expect(mine.notificationEpoch).not.toBe(theirs.notificationEpoch)
    expect(mine.notificationId).not.toBe(theirs.notificationId)
  })

  it('restores the same id on an alert and its dismissal when the alert body fills the budget', () => {
    const notificationId = `agent:${'%D0%BF'.repeat(100)}`
    const full = alert({
      notificationId,
      title: 'Ж'.repeat(80),
      body: '🙂'.repeat(90),
      worktreeId: `repo::${'п'.repeat(300)}`
    })
    const opened = openSealedPushNotification(sealPushNotification(full, TOKEN), TOKEN)
    const dismissed = openSealedPushNotification(
      sealPushNotification({ ...full, kind: 'dismiss', notificationSeq: 4 }, TOKEN),
      TOKEN
    )
    expect(opened.notificationId).toBe(notificationId)
    expect(dismissed.notificationId).toBe(notificationId)
  })

  it('fits a worst-case title at every id length near the budget edge', () => {
    for (let length = 950; length <= 1000; length += 1) {
      const full = alert({
        notificationId: `agent:${'a'.repeat(length)}`,
        title: '\u0000'.repeat(80),
        body: '🙂'.repeat(90)
      })
      const wire = sealPushNotification(full, TOKEN)
      const dismiss = sealPushNotification({ ...full, kind: 'dismiss', notificationSeq: 4 }, TOKEN)
      expectWithinGatewayLimits(wire)
      expect(openSealedPushNotification(wire, TOKEN).notificationId).toBe(
        openSealedPushNotification(dismiss, TOKEN).notificationId
      )
    }
  })

  it('keeps an id too long to seal opaque on both an alert and its dismissal', () => {
    const full = alert({ notificationId: `agent:${'%D0%BF'.repeat(300)}` })
    const opened = openSealedPushNotification(sealPushNotification(full, TOKEN), TOKEN)
    const dismissed = openSealedPushNotification(
      sealPushNotification({ ...full, kind: 'dismiss', notificationSeq: 4 }, TOKEN),
      TOKEN
    )
    expect(opened.notificationId).toMatch(/^e2e1\./)
    expect(dismissed.notificationId).toBe(opened.notificationId)
  })

  it('stays inside the gateway budgets with maximal multibyte text', () => {
    const wire = sealPushNotification(
      alert({
        title: 'Ж'.repeat(80),
        body: '🙂'.repeat(90),
        worktreeId: `repo::${'п'.repeat(600)}`,
        notificationId: `agent:${'%D0%BF'.repeat(300)}`,
        notificationEpoch: 'e'.repeat(128)
      }),
      TOKEN
    )
    expectWithinGatewayLimits(wire)
    expect(openSealedPushNotification(wire, TOKEN).title).toBe('Ж'.repeat(80))
  })
})

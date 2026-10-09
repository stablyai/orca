import { beforeEach, expect, it, vi } from 'vitest'
import { SEALED_VECTOR, sealedVectorHost } from './push-sealed-payload.test-fixture'
import { openSealedPushData, openSealedPushEnvelope } from './push-sealed-payload'

const hosts = vi.hoisted(() => {
  const value: unknown[] = []
  return { value }
})
vi.mock('../transport/host-store', () => ({ loadHosts: vi.fn(async () => hosts.value) }))

beforeEach(() => {
  hosts.value = [sealedVectorHost()]
})

it('opens an envelope sealed by the desktop', () => {
  expect(openSealedPushEnvelope(SEALED_VECTOR.paneKey, SEALED_VECTOR.deviceToken)).toEqual({
    t: 'wt - Claude finished',
    b: 'Готово ✓',
    w: 'repo::wt',
    n: 'agent:wt:pane:1',
    e: 'epoch-1'
  })
  expect(openSealedPushEnvelope(SEALED_VECTOR.paneKey, 'e'.repeat(48))).toBeNull()
  expect(openSealedPushEnvelope('e2e1:not base64!', SEALED_VECTOR.deviceToken)).toBeNull()
})

it('restores the real fields for the host the fingerprint names', async () => {
  const opened = await openSealedPushData(SEALED_VECTOR.fcmData)
  expect(opened).toMatchObject({
    opened: true,
    title: 'wt - Claude finished',
    body: 'Готово ✓',
    data: {
      notificationId: 'agent:wt:pane:1',
      notificationEpoch: 'epoch-1',
      worktreeId: 'repo::wt',
      title: 'wt - Claude finished',
      message: 'Готово ✓'
    }
  })
  expect(opened?.data).not.toHaveProperty('paneKey')
})

it('strips an envelope it cannot open instead of passing ciphertext on as a pane', async () => {
  hosts.value = [sealedVectorHost('e'.repeat(48))]
  const opened = await openSealedPushData(SEALED_VECTOR.fcmData)
  expect(opened?.opened).toBe(false)
  expect(opened?.data).not.toHaveProperty('paneKey')
  expect(opened?.data.notificationId).toBe(SEALED_VECTOR.fcmData.notificationId)
})

it('keeps the envelope for a later read when the host store fails', async () => {
  const { loadHosts } = await import('../transport/host-store')
  vi.mocked(loadHosts).mockRejectedValueOnce(new Error('keystore locked'))
  const opened = await openSealedPushData(SEALED_VECTOR.fcmData)
  expect(opened).toEqual({ data: SEALED_VECTOR.fcmData, opened: false })
  expect((await openSealedPushData(opened?.data))?.opened).toBe(true)
})

it('ignores data that carries no envelope', async () => {
  expect(await openSealedPushData({ hostFingerprint: 'x', paneKey: 'pane-1' })).toBeNull()
  expect(await openSealedPushData(null)).toBeNull()
})

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PushUnregisterOutbox } from './push-unregister-outbox'

const OUTBOX_FILENAME = 'mobile-push-unregister-outbox.json'

function userDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'orca-push-outbox-'))
}

describe('PushUnregisterOutbox', () => {
  it('survives a restart with the queued delete intact', () => {
    const dir = userDataDir()
    const first = new PushUnregisterOutbox(dir)
    const item = first.enqueue({ registrationId: 'reg-1', deviceId: 'device-1' })

    const reopened = new PushUnregisterOutbox(dir)
    expect(reopened.pending()).toEqual([item])
  })

  it('coalesces repeat enqueues of the same registration', () => {
    const dir = userDataDir()
    const outbox = new PushUnregisterOutbox(dir)
    const first = outbox.enqueue({ registrationId: 'reg-1', deviceId: 'device-1' })
    const second = outbox.enqueue({ registrationId: 'reg-1', deviceId: 'device-1' })

    expect(second.reqId).toBe(first.reqId)
    expect(outbox.pending()).toHaveLength(1)
  })

  it('keeps a removal durable across a restart', () => {
    const dir = userDataDir()
    const outbox = new PushUnregisterOutbox(dir)
    const kept = outbox.enqueue({ registrationId: 'reg-keep', deviceId: 'device-1' })
    const dropped = outbox.enqueue({ registrationId: 'reg-drop', deviceId: 'device-2' })
    outbox.remove(dropped.reqId)

    expect(new PushUnregisterOutbox(dir).pending()).toEqual([kept])
  })

  it('drops malformed rows instead of failing the whole load', () => {
    const dir = userDataDir()
    const valid = new PushUnregisterOutbox(dir).enqueue({
      registrationId: 'reg-1',
      deviceId: 'device-1'
    })
    const path = join(dir, OUTBOX_FILENAME)
    const stored: unknown[] = JSON.parse(readFileSync(path, 'utf-8'))
    writeFileSync(
      path,
      JSON.stringify([...stored, { reqId: 'broken' }, null, 'nope', { registrationId: '' }])
    )

    expect(new PushUnregisterOutbox(dir).pending()).toEqual([valid])
  })

  it('starts empty when the file is not JSON at all', () => {
    const dir = userDataDir()
    writeFileSync(join(dir, OUTBOX_FILENAME), 'not json')
    expect(new PushUnregisterOutbox(dir).pending()).toEqual([])
  })
})

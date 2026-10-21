// Runtime probe: real mock-desktop settings.get replies through the migrated acceptance layer.
import WebSocket from 'ws'
import nacl from 'tweetnacl'
import { readFileSync } from 'node:fs'
import { deriveSharedKey, e2eeDecrypt, e2eeEncrypt } from '../../scripts/mock-server-encryption.ts'
import {
  botOverridesRead,
  newTabSettingsRead,
  optionalSettingsRead,
  settingsRead
} from '../../src/transport/settings-read-operations.ts'

const PORT = Number(process.env.PORT) || 6768
const KEY_FILE = process.env.MOCK_SERVER_KEY_FILE!
const serverPublic = nacl.box.keyPair.fromSecretKey(
  Uint8Array.from(Buffer.from(readFileSync(KEY_FILE, 'utf-8').trim(), 'base64'))
).publicKey

function rawReply(): Promise<unknown> {
  const kp = nacl.box.keyPair()
  const key = deriveSharedKey(kp.secretKey, serverPublic)
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`)
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (value: unknown) => {
      if (!settled) {
        settled = true
        try {
          ws.close()
        } catch {}
        resolve(value)
      }
    }
    const timer = setTimeout(() => finish({ __outcome: 'no-reply-timeout' }), 5000)
    ws.on('open', () =>
      ws.send(
        JSON.stringify({
          type: 'e2ee_hello',
          publicKeyB64: Buffer.from(kp.publicKey).toString('base64')
        })
      )
    )
    ws.on('close', () => {
      clearTimeout(timer)
      finish({ __outcome: 'socket-closed-before-reply' })
    })
    ws.on('error', (e) => {
      clearTimeout(timer)
      if (!settled) {
        settled = true
        reject(e)
      }
    })
    ws.on('message', (data) => {
      const text = data.toString('utf-8')
      if (text.startsWith('{"type":"e2ee_ready"')) {
        ws.send(
          e2eeEncrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: 'mock-device-token' }), key)
        )
        return
      }
      const plain = e2eeDecrypt(text, key)
      if (plain === null) {
        return
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the probe prints whatever the host sent, so the frame is read as a bag of fields.
      const frame = JSON.parse(plain) as { type?: string; id?: string }
      if (frame.type === 'e2ee_authenticated') {
        ws.send(
          e2eeEncrypt(
            JSON.stringify({ id: 'probe-1', method: 'settings.get', token: 'mock-device-token' }),
            key
          )
        )
        return
      }
      if (frame.id === 'probe-1') {
        clearTimeout(timer)
        finish(frame)
      }
    })
  })
}

function describe(label: string, run: () => unknown): string {
  try {
    const value = run()
    return `${label}=${JSON.stringify(value)}`
  } catch (error) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a thrown value is not an Error by type; only its constructor name and message are printed.
    return `${label}=THREW ${(error as Error).constructor.name}: ${(error as Error).message}`
  }
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the probe substitutes one recorded reply for the whole client surface.
const reply = (await rawReply()) as Record<string, unknown>
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the probe substitutes one recorded reply for the whole client surface.
const client = {
  sendRequest: async () => reply
} as unknown as Parameters<typeof settingsRead.request>[0]

const lines: string[] = [`mode=${process.env.MOCK_SETTINGS_GET_MODE ?? 'ok'}`]
lines.push(`wireReply=${JSON.stringify(reply)}`)
if (reply.__outcome) {
  lines.push('interpret=skipped (no reply frame)')
} else {
  for (const [name, op] of [
    ['settingsRead', settingsRead],
    ['optionalSettingsRead', optionalSettingsRead],
    ['botOverridesRead', botOverridesRead],
    ['newTabSettingsRead', newTabSettingsRead]
  ] as const) {
    const response = await op.request(client)
    lines.push(
      describe(name, () => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each operation is driven through its own declared reply type in turn.
        const outcome = op.interpret(response as never) as
          | (() => unknown)
          | { accepted?: boolean; value?: unknown }
        // new-tab acceptance returns a deferred reader, not an accept envelope.
        if (typeof outcome === 'function') {
          return { deferred: outcome() }
        }
        const value = typeof outcome?.value === 'function' ? outcome.value() : outcome?.value
        return outcome?.accepted === undefined ? value : { accepted: outcome.accepted, value }
      })
    )
  }
}
process.stdout.write(lines.join('\n') + '\n')

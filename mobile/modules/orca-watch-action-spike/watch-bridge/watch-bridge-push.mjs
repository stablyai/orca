// Watch push for the bridge: device registry and one APNs alert per newly waiting prompt, sent straight
// to the Watch app's own token with the team's .p8 key from ~/.orca/watch-apns.
import { createPrivateKey, sign } from 'node:crypto'
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { connect as connectHttp2 } from 'node:http2'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEVICES_PATH = join(homedir(), '.orca', 'watch-bridge-devices.json')
const APNS_DIR = join(homedir(), '.orca', 'watch-apns')
const APNS_TEAM_ID = process.env.ORCA_WATCH_APNS_TEAM_ID ?? '28HX49S37H'
const APNS_TOPIC = process.env.ORCA_WATCH_APNS_TOPIC ?? 'com.cjna.orca.watch'

function loadDevices() {
  try {
    return JSON.parse(readFileSync(DEVICES_PATH, 'utf8'))
  } catch {
    return []
  }
}

function saveDevices(devices) {
  writeFileSync(DEVICES_PATH, JSON.stringify(devices, null, 2), { mode: 0o600 })
  chmodSync(DEVICES_PATH, 0o600)
}

export function registerDevice(body) {
  const deviceToken = String(body.deviceToken ?? '')
  const environment = body.environment === 'production' ? 'production' : 'development'
  if (!/^[0-9a-f]{64,200}$/.test(deviceToken)) {
    return { status: 400, body: { error: 'Bad device token' } }
  }
  const devices = loadDevices().filter((device) => device.deviceToken !== deviceToken)
  devices.push({ deviceToken, environment, registeredAt: Date.now() })
  saveDevices(devices)
  console.log(`registered Watch push token …${deviceToken.slice(-6)} (${environment})`)
  return { status: 200, body: { ok: true } }
}

export function loadApnsKey() {
  const file =
    existsSync(APNS_DIR) && readdirSync(APNS_DIR).find((name) => /^AuthKey_\w{10}\.p8$/.test(name))
  if (!file) {
    return null
  }
  return {
    keyId: file.slice(8, 18),
    key: createPrivateKey(readFileSync(join(APNS_DIR, file), 'utf8'))
  }
}

let apnsJwt = null
function apnsAuthorization(apnsKey) {
  // Apple accepts a provider token for up to an hour; refresh well before that.
  if (apnsJwt && Date.now() - apnsJwt.issuedAt < 40 * 60 * 1000) {
    return apnsJwt.value
  }
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const issuedAt = Date.now()
  const unsigned = `${encode({ alg: 'ES256', kid: apnsKey.keyId })}.${encode({ iss: APNS_TEAM_ID, iat: Math.floor(issuedAt / 1000) })}`
  const signature = sign('sha256', Buffer.from(unsigned), {
    key: apnsKey.key,
    dsaEncoding: 'ieee-p1363'
  })
  apnsJwt = { issuedAt, value: `bearer ${unsigned}.${signature.toString('base64url')}` }
  return apnsJwt.value
}

function sendApns(apnsKey, device, payload, collapseId) {
  const host =
    device.environment === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com'
  return new Promise((resolve) => {
    const client = connectHttp2(`https://${host}`)
    let settled = false
    const finish = (result) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      client.destroy()
      resolve(result)
    }
    const timer = setTimeout(() => finish({ status: 0, reason: 'timeout' }), 10000)
    client.on('error', (error) => finish({ status: 0, reason: error.message }))
    const request = client.request({
      ':method': 'POST',
      ':path': `/3/device/${device.deviceToken}`,
      authorization: apnsAuthorization(apnsKey),
      'apns-topic': APNS_TOPIC,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(Date.now() / 1000) + 600),
      'apns-collapse-id': collapseId
    })
    let status = 0
    let body = ''
    // A stream reset errors the request, not the session.
    request.on('error', (error) => finish({ status: 0, reason: error.message }))
    request.on('response', (headers) => (status = headers[':status']))
    request.setEncoding('utf8')
    request.on('data', (chunk) => (body += chunk))
    request.on('end', () => {
      let parsed = {}
      try {
        parsed = body ? JSON.parse(body) : {}
      } catch {
        parsed = { reason: body.slice(0, 120) }
      }
      finish({ status, reason: parsed.reason ?? '', timestamp: parsed.timestamp })
    })
    request.end(JSON.stringify(payload))
  })
}

// 0 is a timeout or connection error; Apple asks for retries on 429 and 5xx.
const isTransientPushFailure = (status) => status === 0 || status === 429 || status >= 500

// Sends to each device that hasn't accepted this prompt yet. Returns whether any should be retried.
export async function notifyWatch(prompt, delivered) {
  const apnsKey = loadApnsKey()
  const devices = loadDevices().filter((device) => !delivered.has(device.deviceToken))
  console.log(`prompt waiting: ${prompt.title} (key=${Boolean(apnsKey)} devices=${devices.length})`)
  if (!apnsKey || devices.length === 0) {
    return false
  }
  let retry = false
  const no = prompt.options.find((option) => /^No\b/.test(option.label))
  const payload = {
    aps: {
      alert: { title: 'Claude needs approval', subtitle: prompt.source, body: prompt.title },
      sound: 'default',
      category: 'orca.prompt'
    },
    promptId: prompt.id,
    yesOptionId: prompt.options[0]?.id,
    ...(no ? { noOptionId: no.id } : {})
  }
  for (const device of devices) {
    const started = Date.now()
    const result = await sendApns(apnsKey, device, payload, prompt.id)
    console.log(
      `push …${device.deviceToken.slice(-6)} ${result.status} ${result.reason} ${Date.now() - started}ms`
    )
    if (
      result.status === 410 ||
      result.reason === 'BadDeviceToken' ||
      result.reason === 'Unregistered'
    ) {
      // Keep a registration the Watch made after APNs invalidated the token.
      const invalidatedAt = Number(result.timestamp) || started
      saveDevices(
        loadDevices().filter(
          (entry) =>
            entry.deviceToken !== device.deviceToken || (entry.registeredAt ?? 0) > invalidatedAt
        )
      )
      delivered.add(device.deviceToken)
    } else if (isTransientPushFailure(result.status)) {
      retry = true
    } else {
      delivered.add(device.deviceToken)
    }
  }
  return retry
}

import { createHash, randomBytes } from 'node:crypto'
import { nextFrame, nextJson, waitForOpen } from './relay-load-control-peer.mjs'

// A paired phone's reconnects: one device install over an invite splice, then real device
// resumes (accept, then the desktop's device-resume-confirm), timed from the phone's side.

const ECHO_INTERVAL_MS = 5_000

const resumeTokenHash = (token) => createHash('sha256').update(token).digest('base64url')

function controlAnswer(peer, reqId, type) {
  return peer.waitForControlMessage(
    (message) =>
      message.reqId === reqId && (message.type === type || message.type === 'control-error')
  )
}

function closeCode(socket, timeoutMs = 2_000) {
  if (socket.readyState === socket.CLOSED) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs)
    socket.once('close', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

// The phone dials, the desktop's control answers conn-open, and the desktop attaches its data leg.
async function dialPhone(peer, credential, relayDeviceId) {
  if (!peer.socket || peer.socket.readyState !== peer.socket.OPEN || peer.generation === undefined) {
    throw Object.assign(new Error('active control required for a phone'), { reason: 'no-control' })
  }
  const assignment = peer.lastAssignment
  const phone = peer.createClientSocket(assignment)
  peer.trackSpliceSocket(phone)
  let data
  try {
    const setData = (socket) => {
      data = socket
    }
    return await attachPhone(peer, { assignment, phone, credential, relayDeviceId, setData })
  } catch (error) {
    // A close before any hello names its code, e.g. 4503 while the database is down.
    const closed = /closed: (\d+)/.exec(String(error.message))
    throw Object.assign(error, {
      reason: error.reason ?? (closed ? `hello-${closed[1]}` : undefined),
      phone,
      data
    })
  }
}

async function attachPhone(peer, { assignment, phone, credential, relayDeviceId, setData }) {
  await waitForOpen(phone)
  const connectionPromise = peer.waitForControlMessage(
    (message) => message.type === 'conn-open' && message.relayDeviceId === relayDeviceId
  )
  connectionPromise.catch(() => undefined)
  const hello = nextJson(phone)
  const startedAt = performance.now()
  phone.send(JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential }))
  // A refused phone gets a failed hello and no conn-open.
  const first = await Promise.race([
    connectionPromise.then((connection) => ({ connection })),
    hello.then((answer) => ({ answer }))
  ])
  if (first.answer) {
    const code = first.answer.code ?? (await closeCode(phone))
    throw Object.assign(new Error(`phone refused: ${code}`), { reason: `hello-${code}` })
  }
  const { connection } = first
  const data = peer.createHostDataSocket(assignment, connection.connId)
  setData(data)
  peer.trackSpliceSocket(data)
  await waitForOpen(data)
  data.send(
    JSON.stringify({
      type: 'host-data-auth',
      v: 1,
      connTicket: connection.connTicket,
      generation: peer.generation
    })
  )
  const answer = await hello
  const acceptMs = performance.now() - startedAt
  if (answer.ok !== true) {
    const code = answer.code ?? (await closeCode(phone))
    throw Object.assign(new Error(`phone refused: ${code}`), { reason: `hello-${code}` })
  }
  return { phone, data, connId: connection.connId, acceptMs }
}

async function echo(phone, data, payload) {
  const toHost = nextFrame(data)
  phone.send(payload)
  if ((await toHost).bytes.toString() !== payload) throw new Error('relay changed phone payload')
  const toPhone = nextFrame(phone)
  data.send(Buffer.from(payload))
  if ((await toPhone).bytes.toString() !== payload) throw new Error('relay changed host payload')
}

function rttMs(socket, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    const startedAt = performance.now()
    const timer = setTimeout(() => finish(undefined), timeoutMs)
    const finish = (value) => {
      clearTimeout(timer)
      socket.off('pong', onPong)
      resolve(value)
    }
    const onPong = () => finish(performance.now() - startedAt)
    socket.on('pong', onPong)
    socket.ping()
  })
}

export async function installRelayLoadResumeDevice(peer, relayDeviceId) {
  const inviteReqId = `load-resume-invite-${peer.index}-${peer.spliceSequence++}`
  const invite = controlAnswer(peer, inviteReqId, 'invite-created')
  peer.socket.send(JSON.stringify({ type: 'invite-create', reqId: inviteReqId, relayDeviceId }))
  const created = await invite
  if (created.type !== 'invite-created') throw new Error(`invite failed: ${created.code}`)
  const splice = await dialPhone(peer, created.inviteToken, relayDeviceId)
  try {
    const token = randomBytes(32).toString('base64url')
    const reqId = `load-resume-install-${peer.index}-${peer.spliceSequence++}`
    const installed = controlAnswer(peer, reqId, 'device-credential-installed')
    peer.socket.send(
      JSON.stringify({
        type: 'device-credential-install',
        v: 1,
        reqId,
        relayDeviceId,
        newResumeTokenHash: resumeTokenHash(token),
        authorization: { mode: 'relay-basis', basisConnId: splice.connId }
      })
    )
    const result = await installed
    if (result.type !== 'device-credential-installed') {
      throw new Error(`device install failed: ${result.code}`)
    }
    return token
  } finally {
    await Promise.all([peer.closeSpliceSocket(splice.phone), peer.closeSpliceSocket(splice.data)])
  }
}

// One resume: accept, confirm, then hold the splice with periodic echoes. Never throws.
export async function resumeRelayLoadPhoneOnce(peer, { token, relayDeviceId }, { holdMs, stopping, delay }) {
  const attempt = { at: Date.now(), cellUrl: peer.lastAssignment?.cellUrl }
  let splice
  try {
    splice = await dialPhone(peer, token, relayDeviceId)
    attempt.acceptMs = Math.round(splice.acceptMs)
    const reqId = `load-resume-confirm-${peer.index}-${peer.spliceSequence++}`
    const confirmed = controlAnswer(peer, reqId, 'device-resume-confirmed')
    const confirmStartedAt = performance.now()
    peer.socket.send(
      JSON.stringify({ type: 'device-resume-confirm', v: 1, reqId, basisConnId: splice.connId })
    )
    const result = await confirmed
    attempt.confirmMs = Math.round(performance.now() - confirmStartedAt)
    if (result.type !== 'device-resume-confirmed') {
      attempt.confirmFailure = String(result.code)
    } else {
      attempt.renewed = result.renewed
    }
    const rtt = await rttMs(splice.phone)
    if (rtt !== undefined) attempt.rttMs = Math.round(rtt)
    const holdUntil = Date.now() + holdMs
    attempt.echoes = 0
    while (!stopping() && Date.now() < holdUntil) {
      await echo(splice.phone, splice.data, `orca-relay-resume:${peer.index}:${attempt.echoes}`)
      attempt.echoes++
      await delay(Math.min(ECHO_INTERVAL_MS, Math.max(0, holdUntil - Date.now())))
    }
    attempt.ok = attempt.confirmFailure === undefined
  } catch (error) {
    attempt.ok = false
    attempt.failure = error.reason ?? (splice ? 'held-splice' : 'accept')
    attempt.error = String(error.message).slice(0, 160)
    if (splice) attempt.heldCloseCode = await closeCode(splice.phone, 100)
    splice ??= { phone: error.phone, data: error.data }
  } finally {
    await Promise.all([peer.closeSpliceSocket(splice?.phone), peer.closeSpliceSocket(splice?.data)])
  }
  return attempt
}

const percentile = (values, fraction) => {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]
}

export function relayLoadResumeSummary(attempts) {
  const accepts = attempts.flatMap((attempt) =>
    attempt.acceptMs === undefined ? [] : [attempt.acceptMs]
  )
  const confirms = attempts.flatMap((attempt) =>
    attempt.confirmMs === undefined || attempt.confirmFailure ? [] : [attempt.confirmMs]
  )
  const rtts = attempts.flatMap((attempt) => (attempt.rttMs === undefined ? [] : [attempt.rttMs]))
  const failures = {}
  for (const attempt of attempts) {
    const reason = attempt.confirmFailure ? `confirm-${attempt.confirmFailure}` : attempt.failure
    if (reason) failures[reason] = (failures[reason] ?? 0) + 1
  }
  return {
    attempts: attempts.length,
    ok: attempts.filter((attempt) => attempt.ok).length,
    acceptMsP50: percentile(accepts, 0.5),
    acceptMsP95: percentile(accepts, 0.95),
    confirmMsP50: percentile(confirms, 0.5),
    confirmMsP95: percentile(confirms, 0.95),
    rttMsP50: percentile(rtts, 0.5),
    failures
  }
}

import { createHash, createHmac } from 'node:crypto'
import { createRequire } from 'node:module'
import { controlPhase } from './relay-load-model.mjs'
import { discardFailedLoadSocket } from './relay-load-connection-failure.mjs'

const requireFromRelay = createRequire(new URL('../../apps/relay/package.json', import.meta.url))
const nacl = requireFromRelay('tweetnacl')
const WebSocket = requireFromRelay('ws')
const { SignJWT } = await import(requireFromRelay.resolve('jose'))
const { buildHostProofMacInput, HOST_CHALLENGE_PLAINTEXT_DOMAIN } = await import(
  requireFromRelay.resolve('@orca-cloud/relay-contract')
)

const CAPACITY_ASSIGNMENT_ERRORS = [
  'relay_capacity_exhausted',
  'relay_connection_headroom_exhausted'
]

function waitForOpen(socket, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('control open timeout')), timeoutMs)
    const finish = (error) => {
      clearTimeout(timer)
      socket.off('open', onOpen)
      socket.off('close', onClose)
      socket.off('error', onError)
      if (error) reject(error)
      else resolve()
    }
    const onOpen = () => finish()
    const onClose = (code, reason) => finish(new Error(`control closed: ${code} ${reason}`))
    const onError = (error) => finish(error)
    socket.once('open', onOpen)
    socket.once('close', onClose)
    socket.once('error', onError)
  })
}

function nextJson(socket, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('control response timeout')), timeoutMs)
    const finish = (error, value) => {
      clearTimeout(timer)
      socket.off('message', onMessage)
      socket.off('close', onClose)
      socket.off('error', onError)
      if (error) reject(error)
      else resolve(value)
    }
    const onMessage = (data) => {
      try {
        finish(undefined, JSON.parse(data.toString()))
      } catch (error) {
        finish(error)
      }
    }
    const onClose = (code, reason) => finish(new Error(`control closed: ${code} ${reason}`))
    const onError = (error) => finish(error)
    socket.once('message', onMessage)
    socket.once('close', onClose)
    socket.once('error', onError)
  })
}

function nextFrame(socket, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('relay frame timeout')), timeoutMs)
    const finish = (error, value) => {
      clearTimeout(timer)
      socket.off('message', onMessage)
      socket.off('close', onClose)
      socket.off('error', onError)
      if (error) reject(error)
      else resolve(value)
    }
    const onMessage = (data, binary) => finish(undefined, { bytes: Buffer.from(data), binary })
    const onClose = (code, reason) => finish(new Error(`splice closed: ${code} ${reason}`))
    const onError = (error) => finish(error)
    socket.once('message', onMessage)
    socket.once('close', onClose)
    socket.once('error', onError)
  })
}

function receiveBinaryStream(socket, expectedBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    let receivedBytes = 0
    const hash = createHash('sha256')
    const timer = setTimeout(() => finish(new Error('relay stream timeout')), timeoutMs)
    const finish = (error, value) => {
      clearTimeout(timer)
      socket.off('message', onMessage)
      socket.off('close', onClose)
      socket.off('error', onError)
      if (error) reject(error)
      else resolve(value)
    }
    const onMessage = (data, binary) => {
      if (!binary) return finish(new Error('relay changed stream opcode'))
      const bytes = Buffer.from(data)
      receivedBytes += bytes.byteLength
      hash.update(bytes)
      if (receivedBytes > expectedBytes) return finish(new Error('relay expanded reader stream'))
      if (receivedBytes === expectedBytes) {
        finish(undefined, { bytes: receivedBytes, digest: hash.digest('hex') })
      }
    }
    const onClose = (code, reason) => finish(new Error(`splice closed: ${code} ${reason}`))
    const onError = (error) => finish(error)
    socket.on('message', onMessage)
    socket.once('close', onClose)
    socket.once('error', onError)
  })
}

function closeInfo(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('reader close timeout')), timeoutMs)
    const finish = (error, value) => {
      clearTimeout(timer)
      socket.off('close', onClose)
      socket.off('error', onError)
      if (error) reject(error)
      else resolve(value)
    }
    const onClose = (code, reason) => finish(undefined, { code, reason: reason.toString() })
    const onError = (error) => finish(error)
    socket.once('close', onClose)
    socket.once('error', onError)
  })
}

export function relayLoadWedgedCloseAccepted(closeCodes) {
  return closeCodes.length === 2 && closeCodes[1] === 4429 &&
    (closeCodes[0] === 4429 || closeCodes[0] === 1006)
}

function waitForClose(socket, timeoutMs = 10_000) {
  if (!socket || socket.readyState === socket.CLOSED) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('close', onClose)
      discardFailedLoadSocket(socket)
      reject(new Error('control close timeout'))
    }, timeoutMs)
    const onClose = () => {
      clearTimeout(timer)
      resolve()
    }
    socket.once('close', onClose)
  })
}

async function cancelResponse(response) {
  try {
    await response.body?.cancel()
  } catch {
    // Preserve the bounded failure classification.
  }
}

function proofForChallenge(challenge, hostSecretKey) {
  const plaintext = nacl.box.open(
    Buffer.from(challenge.ciphertextB64, 'base64'),
    Buffer.from(challenge.nonceB64, 'base64'),
    Buffer.from(challenge.relayEphemeralPublicKeyB64, 'base64'),
    hostSecretKey
  )
  if (!plaintext) throw new Error('host proof challenge did not decrypt')
  const domain = new TextEncoder().encode(`${HOST_CHALLENGE_PLAINTEXT_DOMAIN}\0`)
  const transcriptLength = new DataView(
    plaintext.buffer,
    plaintext.byteOffset + domain.length,
    4
  ).getUint32(0, false)
  const transcriptStart = domain.length + 4
  const transcript = plaintext.slice(transcriptStart, transcriptStart + transcriptLength)
  const secret = plaintext.slice(transcriptStart + transcriptLength)
  return createHmac('sha256', secret).update(buildHostProofMacInput(transcript)).digest('base64')
}

export class RelayLoadControlPeer {
  constructor(index, options, observe) {
    if (options.directorOrigin && options.targetOrigin) {
      throw new Error('provide either directorOrigin or targetOrigin, not both')
    }
    this.index = index
    this.options = options
    this.observe = observe
    this.keys = nacl.box.keyPair()
    this.relayHostId = createHash('sha256')
      .update(this.keys.publicKey)
      .digest('base64url')
      .slice(0, 16)
    this.phase = controlPhase(index, options.seed)
    this.socket = null
    this.generation = undefined
    this.controlResumeSecret = undefined
    this.lastAssignment = undefined
    this.refreshTimer = null
    this.stopped = false
    this.connecting = false
    this.inFlight = new Set()
    this.shutdownPromise = null
    this.abortController = new AbortController()
    this.drainExpected = false
    this.controlWaiters = new Set()
    this.spliceSockets = new Set()
    this.spliceSequence = 0
  }

  connect() {
    if (
      this.stopped ||
      this.connecting ||
      (this.socket !== null && this.socket.readyState === this.socket.OPEN)
    ) {
      return Promise.resolve()
    }
    this.connecting = true
    const operation = this.connectOnce()
    this.inFlight.add(operation)
    const finish = () => {
      this.connecting = false
      this.inFlight.delete(operation)
    }
    operation.then(finish, finish)
    return operation
  }

  assignedCellUrl() {
    return this.lastAssignment?.cellUrl
  }

  async connectOnce() {
    let socket = null
    try {
      const relayToken = await this.relayToken()
      if (this.stopped) return
      const assignment = await this.assignment(relayToken)
      if (this.stopped) return
      this.lastAssignment = assignment
      socket = this.createSocket(assignment, relayToken)
      this.socket = socket
      this.drainExpected = false
      await waitForOpen(socket)
      if (this.stopped || this.socket !== socket) return
      socket.send(
        JSON.stringify({
          type: 'host-hello',
          v: 1,
          relayHostId: this.relayHostId,
          assignmentEpoch: assignment.assignmentEpoch,
          hostPublicKeyB64: Buffer.from(this.keys.publicKey).toString('base64'),
          appVersion: 'relay-load',
          ...(this.generation === undefined ? {} : { previousGeneration: this.generation }),
          ...(this.controlResumeSecret === undefined
            ? {}
            : { controlResumeSecret: this.controlResumeSecret })
        })
      )
      const challenge = await nextJson(socket)
      if (this.stopped || this.socket !== socket) return
      if (challenge.type !== 'host-challenge') throw new Error('expected host challenge')
      socket.send(
        JSON.stringify({
          type: 'host-challenge-ack',
          challengeId: challenge.challengeId,
          proofB64: proofForChallenge(challenge, this.keys.secretKey)
        })
      )
      const ack = await nextJson(socket)
      if (this.stopped || this.socket !== socket) return
      if (ack.type !== 'host-hello-ack') throw new Error('expected host hello acknowledgement')
      this.generation = ack.generation
      this.controlResumeSecret = ack.controlResumeSecret
      socket.on('message', (data) => this.onMessage(socket, data))
      socket.once('close', (code) => this.onClose(socket, code))
      socket.once('error', (error) => this.observe('socketError', { index: this.index, error }))
      this.observe('connected', { index: this.index })
      this.scheduleRefresh(this.phase.refreshOffsetMs)
    } catch (error) {
      discardFailedLoadSocket(socket)
      if (this.socket === socket) this.socket = null
      if (this.stopped) return
      throw error
    }
  }

  createSocket(assignment, relayToken) {
    return new WebSocket(`${assignment.cellUrl.replace(/^http/, 'ws')}/v1/host/control`, {
      headers: { authorization: `Bearer ${relayToken}` },
      perMessageDeflate: false
    })
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise
    this.stopped = true
    this.abortController.abort()
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    this.shutdownPromise = this.shutdownOnce()
    return this.shutdownPromise
  }

  async shutdownOnce() {
    const socket = this.socket
    const closed = waitForClose(socket)
    for (const spliceSocket of this.spliceSockets) {
      if (
        spliceSocket.readyState !== spliceSocket.CLOSED &&
        spliceSocket.readyState !== spliceSocket.CLOSING
      ) {
        spliceSocket.close(1000, 'load complete')
      }
    }
    this.rejectControlWaiters(new Error('control stopped'))
    if (socket && socket.readyState !== socket.CLOSED && socket.readyState !== socket.CLOSING) {
      socket.close(1000, 'load complete')
    }
    const settled = async () => {
      while (this.inFlight.size > 0) {
        await Promise.allSettled([...this.inFlight])
      }
    }
    await Promise.all([closed, settled()])
    this.observe('shutdown', {
      index: this.index,
      activeControls: this.socket?.readyState === this.socket?.OPEN ? 1 : 0,
      activeSpliceSockets: this.spliceSockets.size,
      inFlightOperations: this.inFlight.size,
      refreshTimerActive: this.refreshTimer !== null
    })
  }

  openSplice(options = {}) {
    if (this.stopped) return Promise.reject(new Error('control stopped'))
    const operation = this.openSpliceOnce(options)
    this.inFlight.add(operation)
    const finish = () => this.inFlight.delete(operation)
    operation.then(finish, finish)
    return operation
  }

  openInviteOffer() {
    if (this.stopped) return Promise.reject(new Error('control stopped'))
    const operation = this.openInviteOfferOnce()
    this.inFlight.add(operation)
    const finish = () => this.inFlight.delete(operation)
    operation.then(finish, finish)
    return operation
  }

  async openInviteOfferOnce() {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      throw new Error('active control required for invite offer')
    }
    const sequence = this.spliceSequence++
    const reqId = `load-offer-${this.index}-${sequence}`
    const response = this.waitForControlMessage(
      (message) =>
        message.reqId === reqId &&
        (message.type === 'invite-created' || message.type === 'control-error')
    )
    this.socket.send(JSON.stringify({
      type: 'invite-create',
      reqId,
      relayDeviceId: `load-offer-device-${this.index}-${sequence}`
    }))
    const result = await response
    if (result.type === 'control-error') throw new Error(`invite offer failed: ${result.code}`)
    if (
      typeof result.inviteToken !== 'string' ||
      !Number.isSafeInteger(result.expiresAt) ||
      result.expiresAt <= Date.now()
    ) throw new Error('relay invite offer response invalid')
  }

  async openSpliceOnce({
    payloadBytes = 64,
    readerMode = 'normal',
    readerHoldMs = 0,
    streamBytes = payloadBytes,
    frameBytes = payloadBytes,
    observeReaderPressure = async () => undefined,
    readerDelay = async (ms) => await new Promise((resolve) => setTimeout(resolve, ms)),
    slowReaderHoldMs = 0,
    holdMs = 0
  } = {}) {
    if (
      !this.socket ||
      this.socket.readyState !== this.socket.OPEN ||
      this.generation === undefined ||
      this.lastAssignment === undefined
    ) {
      throw new Error('active control required for splice')
    }
    if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 1) {
      throw new Error('splice payload bytes must be positive')
    }
    const sequence = this.spliceSequence++
    const reqId = `load-invite-${this.index}-${sequence}`
    const relayDeviceId = `load-device-${this.index}-${sequence}`
    let phone
    let data
    let opened = false
    try {
      const invitePromise = this.waitForControlMessage(
        (message) => message.type === 'invite-created' && message.reqId === reqId
      )
      this.socket.send(JSON.stringify({ type: 'invite-create', reqId, relayDeviceId }))
      const invite = await invitePromise
      if (typeof invite.inviteToken !== 'string') throw new Error('relay invite response invalid')

      phone = this.createClientSocket(this.lastAssignment)
      this.trackSpliceSocket(phone)
      await waitForOpen(phone)
      const connectionPromise = this.waitForControlMessage(
        (message) => message.type === 'conn-open' && message.relayDeviceId === relayDeviceId
      )
      phone.send(
        JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential: invite.inviteToken })
      )
      const connection = await connectionPromise
      if (typeof connection.connId !== 'string' || typeof connection.connTicket !== 'string') {
        throw new Error('relay connection response invalid')
      }

      data = this.createHostDataSocket(this.lastAssignment, connection.connId)
      this.trackSpliceSocket(data)
      await waitForOpen(data)
      const phoneHello = nextJson(phone)
      data.send(
        JSON.stringify({
          type: 'host-data-auth',
          v: 1,
          connTicket: connection.connTicket,
          generation: this.generation
        })
      )
      if ((await phoneHello).ok !== true) throw new Error('relay rejected load splice')

      if (slowReaderHoldMs > 0 && readerMode === 'normal') {
        readerMode = 'slow'
        readerHoldMs = slowReaderHoldMs
        streamBytes = payloadBytes
        frameBytes = payloadBytes
      }
      if (!['normal', 'slow', 'wedged'].includes(readerMode)) {
        throw new Error('reader mode is invalid')
      }
      const pausedSocket = readerMode === 'normal' ? undefined : phone._socket
      if (readerMode !== 'normal' && !pausedSocket) throw new Error('reader transport unavailable')
      if (readerMode === 'wedged') {
        const closes = [closeInfo(phone, readerHoldMs + 10_000), closeInfo(data, readerHoldMs + 10_000)]
        pausedSocket.pause()
        const readerPausedAt = Date.now()
        const readerPressure = observeReaderPressure({
          cellOrigin: this.lastAssignment.cellUrl,
          readerMode,
          streamBytes
        })
        const [sent] = await Promise.all([
          this.sendReaderStream(data, sequence, streamBytes, frameBytes, readerDelay),
          readerPressure
        ])
        await readerDelay(Math.max(0, readerHoldMs - (Date.now() - readerPausedAt)))
        pausedSocket.resume()
        const closeEvidence = await Promise.all(closes)
        const closeCodes = closeEvidence.map(({ code }) => code)
        if (!relayLoadWedgedCloseAccepted(closeCodes)) {
          throw new Error(`wedged reader close codes: ${closeCodes.join(',')}`)
        }
        opened = true
        this.observe('spliceOpened', { index: this.index, readerMode })
        this.observe('spliceWedged', { index: this.index, code: 4429, streamBytes: sent.bytes })
        return
      }

      const expectedStreamBytes = readerMode === 'slow' ? streamBytes : payloadBytes
      const expectedFrameBytes = readerMode === 'slow' ? frameBytes : payloadBytes
      const phoneStream = receiveBinaryStream(
        phone,
        expectedStreamBytes,
        readerMode === 'slow' ? readerHoldMs + 10_000 : 10_000
      )
      const readerPausedAt = pausedSocket ? Date.now() : 0
      if (pausedSocket) pausedSocket.pause()
      const readerPressure = readerMode === 'slow'
        ? observeReaderPressure({
            cellOrigin: this.lastAssignment.cellUrl,
            readerMode,
            streamBytes: expectedStreamBytes
          })
        : Promise.resolve()
      const [sent] = await Promise.all([
        this.sendReaderStream(
          data,
          sequence,
          expectedStreamBytes,
          expectedFrameBytes,
          readerDelay
        ),
        readerPressure
      ])
      if (readerMode === 'slow') {
        await readerDelay(Math.max(0, readerHoldMs - (Date.now() - readerPausedAt)))
        pausedSocket.resume()
      }
      const receivedByPhone = await phoneStream
      if (receivedByPhone.bytes !== sent.bytes || receivedByPhone.digest !== sent.digest) {
        throw new Error('relay changed host-to-client splice payload')
      }

      const textPayload = `orca-relay-load:${this.index}:${sequence}:${payloadBytes}`
      const dataFrame = nextFrame(data)
      phone.send(textPayload)
      const receivedByHost = await dataFrame
      if (receivedByHost.binary || receivedByHost.bytes.toString() !== textPayload) {
        throw new Error('relay changed client-to-host splice payload')
      }
      opened = true
      this.observe('spliceOpened', { index: this.index, readerMode })
      if (holdMs > 0 && !(await this.waitForSpliceHold(holdMs, [phone, data]))) return
      this.observe('spliceCompleted', { index: this.index, readerMode })
    } catch (error) {
      if (!this.stopped) this.observe('spliceFailed', { index: this.index, error })
      throw error
    } finally {
      await Promise.all([this.closeSpliceSocket(phone), this.closeSpliceSocket(data)])
      if (opened) this.observe('spliceClosed', { index: this.index })
    }
  }

  waitForSpliceHold(holdMs, sockets) {
    if (this.stopped) return Promise.resolve(false)
    return new Promise((resolve, reject) => {
      const finish = (error, completed = false) => {
        clearTimeout(timer)
        this.abortController.signal.removeEventListener('abort', onAbort)
        for (const socket of sockets) {
          socket.off('close', onClose)
          socket.off('error', onError)
        }
        if (error) reject(error)
        else resolve(completed)
      }
      const onAbort = () => finish(undefined, false)
      const onClose = (code, reason) => finish(new Error(`splice closed: ${code} ${reason}`))
      const onError = (error) => finish(error)
      const timer = setTimeout(() => finish(undefined, true), holdMs)
      this.abortController.signal.addEventListener('abort', onAbort, { once: true })
      for (const socket of sockets) {
        socket.once('close', onClose)
        socket.once('error', onError)
      }
    })
  }

  createClientSocket(assignment) {
    return new WebSocket(
      `${assignment.cellUrl.replace(/^http/, 'ws')}/v1/connect/${this.relayHostId}`,
      { perMessageDeflate: false }
    )
  }

  createHostDataSocket(assignment, connId) {
    return new WebSocket(
      `${assignment.cellUrl.replace(/^http/, 'ws')}/v1/host/data/${connId}`,
      { perMessageDeflate: false }
    )
  }

  splicePayload(sequence, payloadBytes) {
    const seed = createHash('sha256')
      .update(`orca-relay-load:${this.index}:${sequence}`)
      .digest()
    return Buffer.allocUnsafe(payloadBytes).map((_, index) => seed[index % seed.length])
  }

  async sendReaderStream(socket, sequence, streamBytes, frameBytes, delay) {
    const hash = createHash('sha256')
    let sentBytes = 0
    let frameIndex = 0
    while (sentBytes < streamBytes) {
      const bytes = Math.min(frameBytes, streamBytes - sentBytes)
      const payload = this.splicePayload(sequence + frameIndex, bytes)
      await this.sendReaderFrame(socket, payload)
      hash.update(payload)
      sentBytes += bytes
      frameIndex++
      while (socket.bufferedAmount > frameBytes) await delay(10)
    }
    return { bytes: sentBytes, digest: hash.digest('hex') }
  }

  sendReaderFrame(socket, payload) {
    if (socket.send.length < 2) {
      socket.send(payload)
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('reader send timeout')), 10_000)
      socket.send(payload, (error) => {
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      })
    })
  }

  trackSpliceSocket(socket) {
    this.spliceSockets.add(socket)
    socket.once('close', () => this.spliceSockets.delete(socket))
  }

  async closeSpliceSocket(socket) {
    if (!socket) return
    const closed = waitForClose(socket).catch(() => undefined)
    if (socket.readyState !== socket.CLOSED && socket.readyState !== socket.CLOSING) {
      socket.close(1000, 'splice complete')
    }
    await closed
    this.spliceSockets.delete(socket)
  }

  async openRebindProbe() {
    if (
      !this.socket ||
      this.socket.readyState !== this.socket.OPEN ||
      this.generation === undefined ||
      this.controlResumeSecret === undefined ||
      this.lastAssignment === undefined
    ) {
      throw new Error('active control required for rebind probe')
    }
    const relayToken = await this.relayToken()
    const socket = new WebSocket(
      `${this.lastAssignment.cellUrl.replace(/^http/, 'ws')}/v1/host/control`,
      {
        headers: { authorization: `Bearer ${relayToken}` },
        perMessageDeflate: false
      }
    )
    try {
      await waitForOpen(socket)
      socket.send(
        JSON.stringify({
          type: 'host-hello',
          v: 1,
          relayHostId: this.relayHostId,
          assignmentEpoch: this.lastAssignment.assignmentEpoch,
          hostPublicKeyB64: Buffer.from(this.keys.publicKey).toString('base64'),
          appVersion: 'relay-load-rebind-proof',
          previousGeneration: this.generation,
          controlResumeSecret: this.controlResumeSecret
        })
      )
      const challenge = await nextJson(socket)
      if (challenge.type !== 'host-challenge') throw new Error('expected host challenge')
      socket.on('error', () => undefined)
      const closed = new Promise((resolve) => socket.once('close', resolve))
      return {
        close: async () => {
          const closeCompleted = waitForClose(socket)
          if (socket.readyState !== socket.CLOSED && socket.readyState !== socket.CLOSING) {
            socket.close(1000, 'rebind boundary proved')
          }
          await closeCompleted
        },
        closed,
        isOpen: () => socket.readyState === socket.OPEN
      }
    } catch (error) {
      discardFailedLoadSocket(socket)
      await waitForClose(socket).catch(() => undefined)
      throw error
    }
  }

  async relayToken() {
    const accessToken = this.options.accessTokenProvider
      ? await this.options.accessTokenProvider()
      : this.options.accessToken
    if (accessToken) {
      const body = await this.requestJson(
        `${this.options.authOrigin}/v1/desktop/auth/relay-token`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            relayHostId: this.relayHostId,
            hostPublicKeyB64: Buffer.from(this.keys.publicKey).toString('base64')
          })
        },
        'relay token exchange timeout',
        (status) => `relay token exchange failed: ${status}`
      )
      if (typeof body.relayToken !== 'string') throw new Error('relay token exchange omitted token')
      if (!this.stopped) this.observe('token', { index: this.index })
      return body.relayToken
    }
    const token = await new SignJWT({
      prof: `load-profile-${this.index}`,
      org: 'relay-load',
      purpose: 'host-control',
      relayHostId: this.relayHostId
    })
      .setProtectedHeader({ alg: 'ES256', kid: this.options.signingKeyId })
      .setIssuer(this.options.authOrigin)
      .setAudience('orca-relay')
      .setSubject(`load-user-${this.index}`)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(this.options.signingKey)
    if (!this.stopped) this.observe('token', { index: this.index })
    return token
  }

  async requestAssignment(preferredRegion) {
    return await this.assignment(await this.relayToken(), preferredRegion)
  }

  async assignment(relayToken, preferredRegion = this.options.preferredRegion) {
    if (!this.options.directorOrigin) {
      if (!this.options.targetOrigin) throw new Error('relay target origin missing')
      return { cellUrl: this.options.targetOrigin, assignmentEpoch: 1 }
    }
    const body = await this.requestJson(
      `${this.options.directorOrigin}/v1/assign`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${relayToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          v: 1,
          relayHostId: this.relayHostId,
          ...(preferredRegion ? { preferredRegion } : {})
        })
      },
      'relay assignment timeout',
      (status, errorCode) =>
        `relay assignment failed: ${status}${errorCode ? ` ${errorCode}` : ''}`,
      CAPACITY_ASSIGNMENT_ERRORS
    )
    if (
      typeof body.cellUrl !== 'string' ||
      !Number.isSafeInteger(body.assignmentEpoch) ||
      body.assignmentEpoch < 1
    ) {
      throw new Error('relay assignment response invalid')
    }
    return body
  }

  async requestJson(url, init, timeoutMessage, httpErrorMessage, allowedErrorCodes = []) {
    const controller = new AbortController()
    const onShutdown = () => controller.abort()
    if (this.abortController.signal.aborted) controller.abort()
    else this.abortController.signal.addEventListener('abort', onShutdown, { once: true })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.options.requestTimeoutMs ?? 10_000)
    try {
      const response = await fetch(url, { ...init, signal: controller.signal })
      if (!response.ok) {
        let bodyConsumed = false
        let errorCode
        if (allowedErrorCodes.length > 0) {
          try {
            const body = await response.json()
            bodyConsumed = true
            if (allowedErrorCodes.includes(body?.error)) errorCode = body.error
          } catch {
            // Preserve the bounded status-only classification.
          }
        }
        if (!bodyConsumed) await cancelResponse(response)
        throw new Error(httpErrorMessage(response.status, errorCode))
      }
      return await response.json()
    } catch (error) {
      if (timedOut) throw new Error(timeoutMessage, { cause: error })
      throw error
    } finally {
      clearTimeout(timer)
      this.abortController.signal.removeEventListener('abort', onShutdown)
    }
  }

  onMessage(socket, data) {
    let message
    try {
      message = JSON.parse(data.toString())
    } catch {
      this.observe('protocolError', { index: this.index })
      return
    }
    for (const waiter of this.controlWaiters) {
      if (waiter.matches(message)) {
        this.controlWaiters.delete(waiter)
        clearTimeout(waiter.timer)
        waiter.resolve(message)
        return
      }
    }
    if (message.type === 'ping') {
      socket.send(JSON.stringify({ type: 'pong', t: message.t }))
      this.observe('ping', { index: this.index })
    } else if (message.type === 'drain') {
      this.drainExpected = true
      this.observe('drain', { index: this.index })
    }
  }

  onClose(socket, code) {
    if (this.socket !== socket) return
    this.socket = null
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    this.rejectControlWaiters(new Error(`control closed: ${code}`))
    this.observe('closed', {
      index: this.index,
      code,
      stopped: this.stopped,
      expectedDrain: this.drainExpected
    })
    this.drainExpected = false
  }

  waitForControlMessage(matches, timeoutMs = 10_000) {
    if (this.stopped) return Promise.reject(new Error('control stopped'))
    return new Promise((resolve, reject) => {
      const waiter = {
        matches,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.controlWaiters.delete(waiter)
          reject(new Error('control response timeout'))
        }, timeoutMs)
      }
      this.controlWaiters.add(waiter)
    })
  }

  rejectControlWaiters(error) {
    for (const waiter of this.controlWaiters) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.controlWaiters.clear()
  }

  scheduleRefresh(delayMs) {
    if (this.stopped) return
    this.refreshTimer = setTimeout(() => {
      void this.refresh().then(
        () => this.scheduleRefresh(this.phase.refreshIntervalMs),
        () => this.scheduleRefresh(this.phase.refreshIntervalMs)
      )
    }, delayMs)
  }

  refresh() {
    if (this.stopped) return Promise.resolve()
    const operation = this.refreshOnce()
    this.inFlight.add(operation)
    const finish = () => this.inFlight.delete(operation)
    operation.then(finish, finish)
    return operation
  }

  async refreshOnce() {
    const socket = this.socket
    if (this.stopped || !socket || socket.readyState !== socket.OPEN) return
    try {
      const relayJwt = await this.relayToken()
      if (this.stopped || this.socket !== socket || socket.readyState !== socket.OPEN) return
      socket.send(JSON.stringify({ type: 'auth-refresh', relayJwt }))
      this.observe('refresh', { index: this.index })
    } catch (error) {
      if (!this.stopped) this.observe('refreshError', { index: this.index, error })
    }
  }
}

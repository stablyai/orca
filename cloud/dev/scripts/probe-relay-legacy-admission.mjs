import { randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const WRONG_CELL = 4409
const DRAINING = 4503

function once(socket, event, listener) {
  if (typeof socket.once === 'function') {
    socket.once(event, listener)
    return
  }
  if (typeof socket.addEventListener !== 'function') {
    throw new Error('WebSocket event API is unavailable')
  }
  socket.addEventListener(event, (value) => {
    if (event === 'close') listener(value.code)
    else if (event === 'error') listener(value.error ?? new Error(value.message))
    else listener()
  }, { once: true })
}

export function parseLegacyAdmissionProbeArguments(argv) {
  if (argv.length !== 2 || argv[0] !== '--cell-origin') throw new Error('invalid arguments')
  const origin = new URL(argv[1])
  if (origin.protocol !== 'https:' || origin.origin !== argv[1]) {
    throw new Error('--cell-origin must be a canonical HTTPS origin')
  }
  return { cellOrigin: origin.origin }
}

export async function probeLegacyAdmission(config, overrides = {}) {
  const Socket = overrides.WebSocket ?? globalThis.WebSocket
  if (typeof Socket !== 'function') throw new Error('WebSocket is unavailable')
  const random = overrides.randomBytes ?? randomBytes
  const timeoutMs = overrides.timeoutMs ?? 15_000
  const hostId = random(12).toString('base64url')
  const credential = random(32).toString('base64url')
  const url = `${config.cellOrigin.replace('https://', 'wss://')}/v1/connect/${hostId}`
  await new Promise((resolve, reject) => {
    const socket = new Socket(url)
    const timer = setTimeout(() => {
      if (typeof socket.terminate === 'function') socket.terminate()
      else socket.close()
      reject(new Error('legacy admission probe timed out'))
    }, timeoutMs)
    once(socket, 'open', () => {
      socket.send(JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential }))
    })
    once(socket, 'close', (code) => {
      clearTimeout(timer)
      if (code === WRONG_CELL) resolve()
      else if (code === DRAINING) reject(new Error('legacy cell is draining'))
      else reject(new Error(`legacy admission probe closed with ${code}`))
    })
    once(socket, 'error', (error) => {
      clearTimeout(timer)
      reject(new Error(`legacy admission probe failed: ${error.message}`))
    })
  })
  return { accepting: true }
}

export async function main(argv = process.argv.slice(2)) {
  const result = await probeLegacyAdmission(parseLegacyAdmissionProbeArguments(argv))
  process.stdout.write(`${JSON.stringify({ event: 'relay_legacy_admission_verified', ...result })}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

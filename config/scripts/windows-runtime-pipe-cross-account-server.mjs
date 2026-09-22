import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'

const deadlineMs = 30_000
const authorizedAccount = readArgument('--authorized-account')
const handoffPath = resolve(readArgument('--handoff'))
assert.match(authorizedAccount, /^[^\\/]+\\[^\\/]+$/)

const root = resolve(import.meta.dirname, '../..')
const brokerPath = resolve(
  root,
  'native',
  'windows-runtime-pipe-broker',
  '.build',
  'orca-pipe-broker.exe'
)
const instanceId = randomUUID().replaceAll('-', '')
const runtimeId = randomUUID().replaceAll('-', '')
const privateEndpoint = `\\\\.\\pipe\\orca-${process.pid}-${runtimeId.slice(0, 4)}`
const capability = randomBytes(32).toString('hex')
const expiresAt = Date.now() + deadlineMs
let broker
let handoffPublished = false
let stopping = false

const server = createServer((socket) => {
  socket.setEncoding('utf8')
  socket.once('data', (data) => {
    let request
    try {
      request = JSON.parse(data.trim())
    } catch {
      socket.end('{\"id\":\"unknown\",\"ok\":false,\"error\":{\"code\":\"bad_request\"}}\n')
      return
    }
    if (request.authToken !== capability) {
      socket.end(
        `${JSON.stringify({
          id: request.id,
          ok: false,
          error: { code: 'unauthorized', message: 'Invalid auth token' }
        })}\n`
      )
      return
    }
    socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { pong: true } })}\n`)
  })
})
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (stopping) return
    stopping = true
    if (handoffPublished) rmSync(handoffPath, { force: true })
    if (broker && broker.exitCode === null && broker.signalCode === null) broker.kill()
    server.close(() => process.exit(1))
    setTimeout(() => process.exit(1), 1_000).unref()
  })
}

try {
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(privateEndpoint, resolveListen)
  })
  broker = spawn(brokerPath, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false
  })
  broker.stderr.pipe(process.stderr)
  broker.stdin.end(
    [
      'ORCA_RUNTIME_PIPE_BROKER_V2',
      instanceId,
      String(process.pid),
      runtimeId,
      authorizedAccount,
      String(deadlineMs),
      ''
    ].join('\n')
  )
  const publicEndpoint = await readReadyEndpoint(broker)
  writeFileSync(
    handoffPath,
    [
      'ORCA_CROSS_ACCOUNT_TEST_V1',
      publicEndpoint,
      capability,
      authorizedAccount,
      String(expiresAt)
    ].join('\n'),
    { encoding: 'utf8', flag: 'wx' }
  )
  handoffPublished = true
  console.log(`AUTHORIZED_SANDBOX_ACCOUNT=${authorizedAccount}`)
  console.log(`PUBLIC_ENDPOINT=${publicEndpoint}`)
  console.log(`PRIVATE_ENDPOINT=${privateEndpoint}`)
  console.log(`HANDOFF_PATH=${handoffPath}`)
  console.log(`DEADLINE_MS=${deadlineMs}`)
  const [code] = await once(broker, 'exit')
  console.log(`BROKER_EXIT=${code}`)
  if (code !== 0) process.exitCode = 1
} finally {
  if (broker && broker.exitCode === null && broker.signalCode === null) broker.kill()
  await new Promise((resolveClose) => server.close(() => resolveClose()))
  if (handoffPublished) rmSync(handoffPath, { force: true })
}

function readArgument(name) {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

async function readReadyEndpoint(child) {
  const result = await Promise.race([
    once(child.stdout, 'data').then(([chunk]) => chunk.toString().trim()),
    once(child, 'exit').then(([code]) => {
      throw new Error(`Broker exited before ready: ${code}`)
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Broker readiness timed out')), 5_000)
    )
  ])
  assert.match(result, /^READY \\\\.\\pipe\\orca-broker-/)
  return result.slice('READY '.length)
}

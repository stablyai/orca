import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { join, resolve } from 'node:path'

if (process.platform !== 'win32') {
  throw new Error('Windows runtime pipe broker tests require Windows.')
}

const root = resolve(import.meta.dirname, '../..')
const brokerPath = join(
  root,
  'native',
  'windows-runtime-pipe-broker',
  '.build',
  'orca-pipe-broker.exe'
)
const probeSource = join(root, 'native', 'windows-runtime-pipe-broker', 'BrokerAccessProbe.cs')
const probePath = join(
  root,
  'native',
  'windows-runtime-pipe-broker',
  '.build',
  'broker-access-probe.exe'
)
const windowsDirectory = process.env.WINDIR ?? process.env.SystemRoot
const compiler = [
  join(windowsDirectory, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  join(windowsDirectory, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe')
].find(existsSync)
assert.ok(compiler, 'C# compiler not found')
assert.equal(
  spawnSync(compiler, ['/nologo', '/target:exe', '/warnaserror+', `/out:${probePath}`, probeSource])
    .status,
  0,
  'access probe compilation failed'
)
const identity = spawnSync(probePath, ['identity'], { encoding: 'utf8' })
assert.equal(identity.status, 0, 'effective account probe failed')
const localAccount = identity.stdout.trim().slice('IDENTITY_ACCOUNT='.length)

await testRpc('valid-capability', true)
await testRpc('invalid-capability', false)
await testSequentialRpcSessions()
await testSlowResponseAndConcurrentRejection()
await testAdministrativeRightsDenied()
await testSupervisorIdentityFence()
await testExactTargetFence()
await testAcceptDeadline()
await testSupervisorDeath()
console.log('WINDOWS_RUNTIME_PIPE_BROKER_SUITE=PASS CASES=9')

async function testRpc(authToken, expectSuccess) {
  const runtimeId = unique('rpc')
  const privateEndpoint = privatePipe(runtimeId, process.pid)
  const server = createServer((socket) => {
    socket.setEncoding('utf8')
    socket.once('data', (data) => {
      const request = JSON.parse(data.trim())
      const response =
        request.authToken === 'valid-capability'
          ? { id: request.id, ok: true, result: { pong: true } }
          : {
              id: request.id,
              ok: false,
              error: { code: 'unauthorized', message: 'Invalid auth token' }
            }
      socket.end(`${JSON.stringify(response)}\n`)
    })
  })
  await listen(server, privateEndpoint)
  const broker = startBroker(runtimeId, 3000)
  const endpoint = await readyEndpoint(broker)
  const response = await request(endpoint, authToken)
  assert.equal(response.ok, expectSuccess)
  assert.equal(
    expectSuccess ? response.result.pong : response.error.code,
    expectSuccess || 'unauthorized'
  )
  broker.kill()
  await once(broker, 'exit')
  await closeServer(server)
  console.log(`RPC_AUTH_${expectSuccess ? 'VALID' : 'INVALID'}=PASS`)
}

async function testSequentialRpcSessions() {
  const runtimeId = unique('sequential')
  const privateEndpoint = privatePipe(runtimeId, process.pid)
  const server = createServer((socket) => {
    socket.setEncoding('utf8')
    socket.once('data', (data) => {
      const request = JSON.parse(data.trim())
      socket.end(`${JSON.stringify({ id: request.id, ok: true, result: { pong: true } })}\n`)
    })
  })
  await listen(server, privateEndpoint)
  const broker = startBroker(runtimeId, 3000)
  const endpoint = await readyEndpoint(broker)
  assert.equal((await request(endpoint, 'valid-capability')).ok, true)
  assert.equal((await request(endpoint, 'valid-capability')).ok, true)
  broker.kill()
  await once(broker, 'exit')
  await closeServer(server)
  console.log('SEQUENTIAL_RPC_SESSIONS=PASS COUNT=2')
}

async function testSlowResponseAndConcurrentRejection() {
  const runtimeId = unique('slow-concurrent')
  const privateEndpoint = privatePipe(runtimeId, process.pid)
  let markRequestSeen
  const requestSeen = new Promise((resolve) => {
    markRequestSeen = resolve
  })
  let operationCount = 0
  const server = createServer((socket) => {
    socket.setEncoding('utf8')
    socket.once('data', (data) => {
      const parsed = JSON.parse(data.trim())
      operationCount += 1
      const currentOperation = operationCount
      markRequestSeen()
      setTimeout(
        () => {
          socket.end(
            `${JSON.stringify({
              id: parsed.id,
              ok: true,
              result: { delayed: currentOperation === 1, operationCount: currentOperation }
            })}\n`
          )
        },
        currentOperation === 1 ? 2500 : 0
      )
    })
  })
  await listen(server, privateEndpoint)
  const broker = startBroker(runtimeId, 6000)
  const endpoint = await readyEndpoint(broker)
  const startedAt = Date.now()
  const firstRequest = request(endpoint, 'valid-capability')
  await requestSeen

  const rawBusy = spawnSync(probePath, [endpoint, String(0x12019b)], { encoding: 'utf8' })
  assert.equal(rawBusy.status, 1, 'raw Win32 open did not report a failed connection')
  assert.match(rawBusy.stdout, /WIN32_ERROR=231/)

  let secondSettled = false
  const secondRequest = request(endpoint, 'valid-capability').finally(() => {
    secondSettled = true
  })
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(
    secondSettled,
    false,
    'Node unexpectedly exposed a terminal result while the one-instance pipe was busy'
  )

  const response = await firstRequest
  assert.equal(response.result.delayed, true)
  assert.ok(Date.now() - startedAt >= 2000, 'slow response did not cross the former two-second cap')
  const secondResponse = await secondRequest
  assert.equal(secondResponse.result.operationCount, 2)
  assert.equal(operationCount, 2, 'a logical request executed more than once')
  broker.kill()
  await once(broker, 'exit')
  await closeServer(server)
  console.log('SLOW_RESPONSE=PASS DELAY_MS=2500')
  console.log('CONCURRENT_SESSION=PASS OPERATIONS=2 EXECUTIONS_PER_OPERATION=1')
  console.log('PIPE_BUSY_RAW_WIN32=231 NODE_EXPOSED_CODE=none NODE_BEHAVIOR=internal-wait')
}

async function testAdministrativeRightsDenied() {
  const runtimeId = unique('rights')
  const broker = startBroker(runtimeId, 3000)
  const endpoint = await readyEndpoint(broker)
  for (const operation of ['create-instance', 0x10000, 0x80000]) {
    const result = spawnSync(probePath, [endpoint, String(operation)], { encoding: 'utf8' })
    assert.equal(result.status, 5, `administrative operation ${operation} was not denied`)
    assert.match(result.stdout, /WIN32_ERROR=5/)
  }
  const writeDac = spawnSync(probePath, [endpoint, String(0x40000)], { encoding: 'utf8' })
  assert.equal(writeDac.status, 0, 'same-owner characterization changed unexpectedly')
  broker.kill()
  await once(broker, 'exit')
  console.log('ADMINISTRATIVE_RIGHTS_DENIED=PASS CASES=3')
  console.log('CHANGE_PERMISSIONS=NOT_DEMONSTRATED REASON=SAME_OWNER_IMPLICIT_WRITE_DAC')
}

async function testExactTargetFence() {
  const runtimeId = unique('target')
  const decoy = createServer(() => {
    throw new Error('broker contacted a non-derived target')
  })
  await listen(decoy, `\\\\.\\pipe\\orca-decoy-${runtimeId}`)
  const broker = startBroker(runtimeId, 350)
  const endpoint = await readyEndpoint(broker)
  const client = createConnection(endpoint)
  client.on('error', () => {})
  client.write('probe')
  const [code] = await once(broker, 'exit')
  client.destroy()
  assert.equal(code, 1460)
  await closeServer(decoy)
  console.log('EXACT_PRIVATE_TARGET=PASS')
}

async function testSupervisorIdentityFence() {
  const broker = spawn(brokerPath, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false
  })
  broker.stdin.end(
    [
      'ORCA_RUNTIME_PIPE_BROKER_V2',
      unique('untrusted-supervisor'),
      String(process.pid + 1),
      unique('runtime'),
      localAccount,
      '500',
      ''
    ].join('\n')
  )
  const [code] = await once(broker, 'exit')
  assert.equal(code, 5)
  console.log('SUPERVISOR_IDENTITY_FENCE=PASS')
}

async function testAcceptDeadline() {
  const broker = startBroker(unique('deadline'), 250)
  await readyEndpoint(broker)
  const [code] = await once(broker, 'exit')
  assert.equal(code, 1460)
  console.log('ACCEPT_DEADLINE=PASS')
}

async function testSupervisorDeath() {
  const fixture = spawn(
    process.execPath,
    [
      join(import.meta.dirname, 'windows-runtime-pipe-broker-supervisor-fixture.mjs'),
      brokerPath,
      unique('supervisor'),
      unique('runtime'),
      localAccount
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false }
  )
  const output = await once(fixture.stdout, 'data')
  const match = output[0].toString().match(/BROKER_PID=(\d+)/)
  assert.ok(match, 'fixture did not report broker pid')
  const brokerPid = Number(match[1])
  fixture.kill()
  await once(fixture, 'exit')
  const stopped = await waitForProcessExit(brokerPid, 2000)
  assert.equal(stopped, true)
  console.log('SUPERVISOR_DEATH_REAPS_BROKER=PASS')
}

function startBroker(runtimeId, deadlineMs) {
  const broker = spawn(brokerPath, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false
  })
  broker.stdin.end(
    [
      'ORCA_RUNTIME_PIPE_BROKER_V2',
      unique('instance'),
      String(process.pid),
      runtimeId,
      localAccount,
      String(deadlineMs),
      ''
    ].join('\n')
  )
  return broker
}

async function readyEndpoint(broker) {
  const line = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('broker readiness timed out')), 2000)
    broker.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`broker exited before ready: ${code}`))
    })
    broker.stdout.once('data', (chunk) => {
      clearTimeout(timer)
      resolve(chunk.toString().trim())
    })
  })
  assert.match(line, /^READY \\\\.\\pipe\\orca-broker-/)
  return line.slice('READY '.length)
}

function privatePipe(runtimeId, pid) {
  const suffix = runtimeId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 4) || 'rt'
  return `\\\\.\\pipe\\orca-${pid}-${suffix}`
}

function listen(server, endpoint) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(endpoint, resolve)
  })
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve))
}

function request(endpoint, authToken) {
  return new Promise((resolve, reject) => {
    const client = createConnection(endpoint)
    let response = ''
    let settled = false
    client.setEncoding('utf8')
    client.once('error', (error) => {
      if (!settled) {
        reject(error)
      }
    })
    client.on('data', (chunk) => {
      response += chunk
      const newline = response.indexOf('\n')
      if (newline !== -1 && !settled) {
        settled = true
        client.end()
        resolve(JSON.parse(response.slice(0, newline)))
      }
    })
    client.once('connect', () => {
      client.write(
        `${JSON.stringify({ id: 'request-1', authToken, method: 'diagnostics.ping' })}\n`
      )
    })
  })
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

function unique(prefix) {
  return `${prefix}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

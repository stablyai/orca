// Fake machine provider (protocolVersion 1) for tests. State lives in FAKE_MACHINE_PROVIDER_STATE.
// FAKE_MACHINE_PROVIDER_MODE: "auth" fails like a rejected ssh login, "hang" never answers,
// "garbage" prints non-JSON, "echo" prints the request it received as a machine detail.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const [verb, , , id] = process.argv.slice(2)
const mode = process.env.FAKE_MACHINE_PROVIDER_MODE ?? ''
const statePath = process.env.FAKE_MACHINE_PROVIDER_STATE
const contextId = process.env.FAKE_MACHINE_PROVIDER_CONTEXT ?? 'fake:tester'
const now = process.env.FAKE_MACHINE_PROVIDER_NOW ?? new Date().toISOString()

const chunks = []
for await (const chunk of process.stdin) {
  chunks.push(chunk)
}
const request = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')

if (mode === 'auth') {
  process.stderr.write('dev@fake: Permission denied (publickey).\n')
  process.exit(255)
}
if (mode === 'hang') {
  setInterval(() => {}, 1000)
} else if (mode === 'garbage') {
  process.stdout.write('not json')
} else {
  run()
}

function load() {
  return statePath && existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, 'utf8'))
    : { machines: [], calls: [] }
}

function respond(state, body, exitCode = 0) {
  state.calls.push({ verb, id: id ?? null, operationId: request.operationId })
  if (statePath) {
    writeFileSync(statePath, JSON.stringify(state))
  }
  process.stdout.write(
    JSON.stringify({
      protocolVersion: 1,
      operationId: request.operationId,
      contextId,
      now,
      ...body
    })
  )
  process.exitCode = exitCode
}

function access(machine) {
  return {
    kind: 'ssh',
    host: machine.host ?? '127.0.0.1',
    port: machine.port ?? 2222,
    user: 'dev',
    projectRoot: '/home/dev/src',
    ...(machine.hostKeyFingerprints ? { hostKeyFingerprints: machine.hostKeyFingerprints } : {})
  }
}

function view(machine) {
  const { host: _host, port: _port, hostKeyFingerprints: _keys, ...rest } = machine
  return machine.state === 'running' ? { ...rest, access: access(machine) } : rest
}

function run() {
  const state = load()
  const machine = state.machines.find((entry) => entry.id === id)
  const notFound = () =>
    respond(state, { kind: 'error', code: 'not-found', message: `no machine ${id}` }, 4)
  switch (verb) {
    case 'capabilities':
      return respond(state, {
        kind: 'capabilities',
        capabilities: {
          verbs: ['create', 'sleep', 'wake', 'archive', 'delete', 'get', 'teleport'],
          lifetimes: ['persistent', 'temporary'],
          defaultTtlSeconds: 7200,
          maxTtlSeconds: 86400,
          contextId,
          contextLabel: 'tester@fake'
        }
      })
    case 'list':
      return respond(state, { kind: 'inventory', machines: state.machines.map(view) })
    case 'get':
      return machine ? respond(state, { kind: 'machine', machine: view(machine) }) : notFound()
    case 'create': {
      const existing = state.machines.find(
        (entry) => entry.creatingOperationId === request.operationId
      )
      if (existing) {
        return respond(state, { kind: 'machine', machine: view(existing) })
      }
      const created = {
        id: `m-${state.machines.length + 1}`,
        name: request.params?.name ?? 'machine',
        lifetime: request.params?.lifetime ?? 'persistent',
        state: 'running',
        createdAt: now,
        creatingOperationId: request.operationId
      }
      state.machines.push(created)
      return respond(state, { kind: 'machine', machine: view(created) })
    }
    case 'sleep':
    case 'wake':
    case 'archive': {
      if (!machine) {
        return notFound()
      }
      machine.state = { sleep: 'sleeping', wake: 'running', archive: 'archived' }[verb]
      return respond(state, { kind: 'machine', machine: view(machine) })
    }
    case 'delete':
      if (!machine) {
        return notFound()
      }
      state.machines = state.machines.filter((entry) => entry !== machine)
      return respond(state, { kind: 'error', code: 'not-found', message: 'deleted' }, 4)
    default:
      return respond(state, { kind: 'error', code: 'unsupported', message: verb }, 2)
  }
}

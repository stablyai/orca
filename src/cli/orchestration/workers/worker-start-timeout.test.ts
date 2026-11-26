import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY } from '../../../shared/orchestration/orchestration-runtime-capabilities'
import { getRuntimeMetadataPath } from '../../../shared/remote-runtime/bootstrap/runtime-bootstrap'
import { RuntimeClient } from '../../runtime/client'
import { ORCHESTRATION_WORKER_LAUNCH_HANDLER } from './worker-launch-handler'

test('a lost worker-start reply returns the original receipt without another start', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'orca-worker-'))
  const windows = process.platform === 'win32'
  const endpoint = windows
    ? `\\\\.\\pipe\\orca-worker-${randomUUID()}`
    : join(profile, 'runtime.sock')
  const runtimeId = 'worker-test-runtime'
  const receipt = { dispatchId: 'dispatch:original', taskId: 'task:original', state: 'ready' }
  const calls: {
    id: string
    method: string
    orchestrationRequestId?: string
    params?: { request?: string }
  }[] = []
  const server = createServer((socket) => {
    socket.setEncoding('utf8')
    let input = ''
    socket.on('data', (chunk: string) => {
      input += chunk
      if (!input.endsWith('\n')) {
        return
      }
      const request: (typeof calls)[number] = JSON.parse(input)
      calls.push(request)
      const reply = (result: unknown) => {
        const output = JSON.stringify({ id: request.id, ok: true, result, _meta: { runtimeId } })
        socket.end(`${output}\n`)
      }
      switch (request.method) {
        case 'status.get':
          reply({ capabilities: [ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY] })
          break
        case 'orchestration.workerStart':
          // The host accepted the start but the client never received its reply.
          vi.advanceTimersByTime(60_000)
          break
        case 'orchestration.requestShow':
          reply({
            requestId: calls.find((call) => call.method === 'orchestration.workerStart')
              ?.orchestrationRequestId,
            method: 'orchestration.workerStart',
            state: 'completed',
            receipt
          })
          break
        default:
          socket.destroy()
      }
    })
  })
  const output = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    server.listen(endpoint)
    await once(server, 'listening')
    await writeFile(
      getRuntimeMetadataPath(profile),
      JSON.stringify({
        runtimeId,
        pid: process.pid,
        authToken: 'fixture',
        startedAt: Date.now(),
        transports: [{ kind: windows ? 'named-pipe' : 'unix', endpoint }]
      }),
      { mode: 0o600 }
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const client = new RuntimeClient(profile, 1_000, null, null)
    const flags = new Map<string, string | boolean>([
      ['agent', 'codex'],
      ['task', receipt.taskId],
      ['from', 'term_fixture'],
      ['timeout-ms', '1'],
      ['full', true]
    ])
    await ORCHESTRATION_WORKER_LAUNCH_HANDLER['orchestration worker-start']({
      flags,
      client,
      cwd: profile,
      json: true
    })

    expect(calls.map(({ method }) => method)).toEqual([
      'status.get',
      'orchestration.workerStart',
      'orchestration.requestShow'
    ])
    const requestId = calls[1]?.orchestrationRequestId
    expect(requestId).toEqual(expect.any(String))
    expect(calls[2]?.params).toEqual({ request: requestId })
    expect(calls[2]?.orchestrationRequestId).toBeUndefined()
    expect(JSON.parse(output.mock.calls[0]?.[0])).toMatchObject({ result: receipt })
  } finally {
    vi.useRealTimers()
    output.mockRestore()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(profile, { recursive: true })
  }
})

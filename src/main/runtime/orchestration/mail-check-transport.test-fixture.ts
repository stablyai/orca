import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { onTestFinished } from 'vitest'
import { z } from 'zod'
import type { OrcaRuntimeService } from '../orca-runtime'
import { createLongPollServer } from '../runtime-rpc-long-poll-server.test-fixture'
import { readRuntimeMetadata } from '../runtime-metadata'
import { openFramedSession, sendRequest } from '../runtime-rpc-test-harness'
import { getProcessStartedAtMs } from '../../daemon/daemon-process-start-time'

/** A separate CLI process talks to the real authenticated runtime server; no dispatcher replacement. */
export async function mailCheckTransport(runtime: OrcaRuntimeService) {
  const directory = await mkdtemp(join(tmpdir(), 'orca-mail-check-'))
  const server = createLongPollServer({ runtime, userDataPath: directory, keepaliveIntervalMs: 20 })
  await server.start()
  onTestFinished(async () => {
    await server.stop()
    await rm(directory, { recursive: true, force: true })
  })
  const metadata = readRuntimeMetadata(directory)!
  const endpoint = metadata.transports[0]!.endpoint
  const childPath = fileURLToPath(new URL('../../../cli/index.ts', import.meta.url))
  const program = createRequire(resolve('package.json')).resolve('bun/bin/bun.exe')
  let sequence = 0
  const request = (params: Record<string, unknown>) => ({
    id: `transport-${++sequence}`,
    authToken: metadata.authToken,
    orchestrationRequestId: randomUUID(),
    method: 'orchestration.check',
    params
  })
  return {
    async cli(flags: Map<string, string | boolean>): Promise<Record<string, unknown>> {
      const output = await new Promise<string>((resolve, reject) => {
        const child = execFile(
          program,
          [
            childPath,
            'orchestration',
            'check',
            ...[...flags].flatMap(([key, value]) =>
              value === true ? [`--${key}`] : [`--${key}`, String(value)]
            ),
            '--json'
          ],
          {
            env: {
              ...process.env,
              ORCA_PANE_KEY: '',
              ORCA_SESSION_ID: '',
              ORCA_AGENT_LAUNCH_TOKEN: '',
              ORCA_USER_DATA_PATH: directory
            },
            maxBuffer: 4 * 1024 * 1024
          },
          (error, stdout, stderr) => {
            if (error) {
              reject(new Error(`${error.message}\n${stderr}`))
            } else {
              resolve(stdout)
            }
          }
        )
        if (!child.pid) {
          reject(new Error('CLI child did not start'))
          return
        }
        console.info('mail-check-owned-child', {
          pid: child.pid,
          startedAt: getProcessStartedAtMs(child.pid),
          program,
          childPath
        })
      })
      return z.object({ result: z.record(z.string(), z.unknown()) }).parse(JSON.parse(output))
        .result
    },
    wait: (params: Record<string, unknown>) => openFramedSession(endpoint, request(params)),
    async check(params: Record<string, unknown>) {
      return sendRequest(endpoint, request(params))
    },
    async rpc(method: string, params: Record<string, unknown>) {
      return sendRequest(endpoint, { ...request(params), method })
    },
    active: () => Reflect.get(server, 'activeLongPolls')
  }
}

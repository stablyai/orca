import { spawnProcess } from '@orca/process-host'
// Real Node children: direct stdout EOF at the connection boundary, then supervised root exit
// while a descendant holds stdout. POSIX supervisors keep their own stdout open after provider EOF.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  GROK_CONFIG_OPTIONS,
  openAcpAdapterRig,
  PROVIDER_SESSION,
  sendHello
} from './acp-structured-adapter.test-support'
import { createAcpAgentConnection } from './acp-agent-connection'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

// Answers the handshake and echoes one reply chunk for the prompt, then runs `onPrompt`.
const agentScript = (onPrompt: string): string => String.raw`
  const fs = require('node:fs')
  fs.writeFileSync(process.env.ORCA_TEST_PID_FILE, String(process.pid))
  const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n')
  let buffered = ''
  process.stdin.setEncoding('utf8').on('data', (chunk) => {
    buffered += chunk
    let newline
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const frame = JSON.parse(buffered.slice(0, newline))
      buffered = buffered.slice(newline + 1)
      if (frame.method === 'initialize') {
        send({ id: frame.id, result: { protocolVersion: 1, agentCapabilities: {} } })
      } else if (frame.method === 'session/new') {
        send({ id: frame.id, result: JSON.parse(process.env.ORCA_TEST_SESSION) })
      } else if (frame.method === '_x.ai/subagent/cancel') {
        send({ id: frame.id, error: {
          code: -32602, message: 'Invalid params', data: 'invalid params: missing field \`subagentId\`'
        } })
      } else if (frame.method === '_x.ai/task/kill') {
        send({ id: frame.id, error: {
          code: -32602, message: 'Invalid params', data: 'invalid params: missing field \`sessionId\`'
        } })
      } else if (frame.method === 'session/prompt') {
        const update = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } }
        send({
          method: 'session/update',
          params: { sessionId: frame.params.sessionId, update, _meta: frame.params._meta }
        })
        process.stdout.write('', () => {
          ${onPrompt}
        })
      }
    }
  })
  setInterval(() => {}, 60000)
`
const CLOSES_STDOUT_MID_TURN = `
  if (process.connected) process.disconnect()
  process.stdin.once('end', () => process.exit(0))
  ${agentScript('fs.closeSync(1)')}
`
// Starts a process that inherits its stdout and outlives it, records that process, then exits.
const EXITS_HOLDING_STDOUT = agentScript(String.raw`
  const held = require('@orca/process-host').spawnProcess({
    program: process.execPath,
    args: ['-e', 'setInterval(() => {}, 60000)'],
    stdio: ['ignore', 'inherit', 'ignore']
  })
  fs.writeFileSync(process.env.ORCA_TEST_PID_FILE + '.held', String(held.pid))
  process.exit(3)
`)

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function ownedPidFile(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  const pidFile = join(directory, 'pid')
  let close = async () => {}
  onTestFinished(async () => {
    try {
      await close()
    } finally {
      try {
        for (const file of [pidFile, `${pidFile}.held`]) {
          if (!existsSync(file)) {
            continue
          }
          const pid = Number(readFileSync(file, 'utf8'))
          if (!Number.isInteger(pid) || pid <= 0) {
            continue
          }
          if (alive(pid)) {
            process.kill(pid)
          }
          await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 10_000, interval: 20 })
        }
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  })
  return {
    pidFile,
    closeWith: (shutdown: () => Promise<void>) => {
      close = shutdown
    }
  }
}

describe('ACP connection to a directly launched agent that closes stdout but keeps running', () => {
  it('leaves the turn running and the agent alive until Orca closes it', async () => {
    const owned = ownedPidFile('orca-acp-broken-stream-')
    const { pidFile } = owned
    let stdoutEnded = false
    const rig = await openAcpAdapterRig({
      deps: {
        stopGraceMs: 20,
        connect: (_launch, options) =>
          createAcpAgentConnection(
            {
              command: process.execPath,
              args: ['-e', CLOSES_STDOUT_MID_TURN],
              cwd: process.cwd(),
              env: {
                ORCA_TEST_PID_FILE: pidFile,
                ORCA_TEST_SESSION: JSON.stringify({
                  sessionId: PROVIDER_SESSION,
                  configOptions: GROK_CONFIG_OPTIONS
                })
              }
            },
            options,
            (spec) => {
              const child = spawnProcess({
                ...spec,
                program: process.execPath,
                args: ['-e', CLOSES_STDOUT_MID_TURN],
                env: { ...spec.env, ORCA_PROVIDER_SUPERVISOR_SPEC: undefined }
              })
              child.stdout.once('end', () => {
                stdoutEnded = true
              })
              return child
            }
          )
      }
    })
    owned.closeWith(() => rig.adapter.closeAll())
    await rig.acquire()
    await sendHello(rig, 'broken')
    const turns = async () =>
      (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
    await vi.waitFor(
      async () => expect((await turns()).at(-1)).toMatchObject({ state: 'running' }),
      { timeout: 10_000, interval: 20 }
    )
    const pid = Number(readFileSync(pidFile, 'utf8'))
    await vi.waitFor(() => expect(stdoutEnded).toBe(true), { timeout: 2_000, interval: 20 })
    expect((await turns()).at(-1)).toMatchObject({ state: 'running' })
    expect(rig.ended).toEqual([])
    expect(alive(pid)).toBe(true)
    await expect(rig.adapter.closeSession(SESSION)).resolves.toBe(true)
    expect(alive(pid)).toBe(false)
    expect(rig.ended).toMatchObject([{ type: 'ended', cause: 'requested-close' }])
  }, 30_000)
})

describe('ACP agent that exits while a process it started holds its stdout open', () => {
  it('ends the session at the exit, with the turn interrupted', async () => {
    const owned = ownedPidFile('orca-acp-held-stdout-')
    const { pidFile } = owned
    const rig = await openAcpAdapterRig({
      deps: {
        connect: (_launch, options) =>
          createAcpAgentConnection(
            {
              command: process.execPath,
              args: ['-e', EXITS_HOLDING_STDOUT],
              cwd: process.cwd(),
              env: {
                ORCA_TEST_PID_FILE: pidFile,
                ORCA_TEST_SESSION: JSON.stringify({
                  sessionId: PROVIDER_SESSION,
                  configOptions: GROK_CONFIG_OPTIONS
                })
              }
            },
            options
          )
      }
    })
    owned.closeWith(() => rig.adapter.closeAll())
    await rig.acquire()
    await sendHello(rig, 'held')
    await vi.waitFor(() => expect(rig.ended).toHaveLength(1), { timeout: 10_000, interval: 20 })
    expect(rig.ended[0]).toMatchObject({ type: 'ended', cause: 'unexpected-exit' })
    expect(alive(Number(readFileSync(pidFile, 'utf8')))).toBe(false)
    const turns = (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
    expect(turns.at(-1)).toMatchObject({ state: 'interrupted' })
  }, 30_000)
})

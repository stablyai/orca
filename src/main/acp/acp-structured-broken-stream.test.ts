// Real children (plain Node, never an agent CLI) behind the real connection. One stops talking
// mid-turn by closing its stdout while the process keeps running: nothing exited and Orca can still
// write to it, so, as in the common pattern, the turn runs on until a Stop or close ends the agent.
// The other exits while a process it started still holds its stdout open: the exit alone ends it.

import { mkdtempSync, readFileSync } from 'node:fs'
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
const CLOSES_STDOUT_MID_TURN = agentScript('fs.closeSync(1)')
// Starts a process that inherits its stdout and outlives it, records that process, then exits.
const EXITS_HOLDING_STDOUT = agentScript(String.raw`
  const held = require('node:child_process').spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 60000)'],
    { stdio: ['ignore', 'inherit', 'ignore'] }
  )
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

describe('ACP agent that closes its stdout but keeps running', () => {
  it('leaves the turn running and the agent alive until Orca closes it', async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), 'orca-acp-broken-stream-')), 'pid')
    const rig = await openAcpAdapterRig({
      deps: {
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
            options
          )
      }
    })
    onTestFinished(async () => {
      await rig.adapter.closeAll().catch(() => {})
    })
    await rig.acquire()
    await sendHello(rig, 'broken')
    const turns = async () =>
      (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
    await vi.waitFor(
      async () => expect((await turns()).at(-1)).toMatchObject({ state: 'running' }),
      { timeout: 10_000, interval: 20 }
    )
    const pid = Number(readFileSync(pidFile, 'utf8'))
    // Long enough for a closed stream to have reached the adapter.
    await new Promise((resolve) => setTimeout(resolve, 500))
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
    const pidFile = join(mkdtempSync(join(tmpdir(), 'orca-acp-held-stdout-')), 'pid')
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
    onTestFinished(async () => {
      await rig.adapter.closeAll().catch(() => {})
      const held = Number(readFileSync(`${pidFile}.held`, 'utf8'))
      if (alive(held)) {
        process.kill(held)
      }
    })
    await rig.acquire()
    await sendHello(rig, 'held')
    await vi.waitFor(() => expect(rig.ended).toHaveLength(1), { timeout: 10_000, interval: 20 })
    expect(rig.ended[0]).toMatchObject({ type: 'ended', cause: 'unexpected-exit' })
    expect(alive(Number(readFileSync(pidFile, 'utf8')))).toBe(false)
    const turns = (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
    expect(turns.at(-1)).toMatchObject({ state: 'interrupted' })
  }, 30_000)
})

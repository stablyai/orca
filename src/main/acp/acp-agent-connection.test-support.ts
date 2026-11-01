import { Duplex, PassThrough } from 'node:stream'
import { vi } from 'vitest'
import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import {
  createAcpAgentConnection,
  type AcpAgentConnection,
  type AcpAgentConnectionOptions
} from './acp-agent-connection'
import { AcpScriptedAgent } from './acp-scripted-agent.test-support'
export const opened: { connection: AcpAgentConnection; exit: () => void }[] = []
export const start = { cwd: '/execution-host/folder', mcpServers: [] }
export function fixture(
  options: AcpAgentConnectionOptions = {},
  behavior: { pid?: number | null; exitOnEnd?: boolean; brokenStdin?: boolean; cwd?: string } = {}
) {
  const agent = new AcpScriptedAgent()
  const child = Object.assign(createFakePipedChild(), {
    pid: behavior.pid === null ? undefined : (behavior.pid ?? 9_999_999),
    stdout: agent.stdout,
    stdin: agent.stdin,
    stderr: new PassThrough(),
    kill: vi.fn(() => true)
  })
  const reportInput = new PassThrough()
  const reportOutput = new PassThrough()
  reportOutput.resume()
  child.stdio[3] = Duplex.from({ readable: reportInput, writable: reportOutput })
  const spawn = vi.fn<PipedProcessSpawner>(() => {
    return child
  })
  agent.on('initialize', (frame) => agent.reply(frame, { protocolVersion: 1 }))
  agent.on('session/new', (frame) => agent.reply(frame, { sessionId: 'session-1' }))
  if (behavior.exitOnEnd !== false) {
    child.stdin.once('finish', () => {
      child.emit('exit', 0, null)
      child.stdout.end()
    })
  }
  if (behavior.brokenStdin) {
    child.stdin.destroy()
  }
  const connection = createAcpAgentConnection(
    {
      command: 'fixture-acp-agent',
      args: ['--acp'],
      cwd: behavior.cwd ?? start.cwd,
      env: { ACP_ACCOUNT_HOME: '/host/account', STRIPPED: 'overlay' },
      envToDelete: ['STRIPPED']
    },
    options,
    spawn
  )
  opened.push({
    connection,
    exit: () => {
      child.emit('exit', 0, null)
      child.stdout.end()
    }
  })
  return { agent, child, spawn, connection, reportInput }
}

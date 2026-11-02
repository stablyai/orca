/**
 * Test-only: a `wsl.exe` spawner whose children run the stdio bridge in-process. Each child dials
 * the port the bridge command names on this machine and prints the real sentinel, so the listener
 * and WSL transport above it run unchanged.
 */
import { EventEmitter } from 'node:events'
import { connect } from 'node:net'
import { PassThrough } from 'node:stream'
import type { PipedChildProcess, PipedProcessSpawner } from '@orca/process-host/process-spec'
import {
  ORCAD_STDIO_BRIDGE_READY,
  ORCAD_STDIO_BRIDGE_REFUSED,
  orcadPosixStdioBridgeCommand
} from '../managed-server/lifecycle/orcad-stdio-bridge-script'
import type { OrcadStdioBridge } from '../ssh/orcad-stdio-bridge'

export type FakeWslBridgeChildren = {
  spawn: PipedProcessSpawner
  /** Every spawned child's guest command, in order. */
  commands: string[]
  live: () => number
  maxLive: () => number
}

/** The bridge the WSL path resolves for a Linux distro, without the platform probe. */
export function posixOrcadStdioBridge(port: number): OrcadStdioBridge {
  return { command: orcadPosixStdioBridgeCommand(port), mode: 'raw', wrapCommand: true }
}

export function fakeWslBridgeChildren(): FakeWslBridgeChildren {
  const commands: string[] = []
  let live = 0
  let maxLive = 0
  const spawn: PipedProcessSpawner = (spec) => {
    const command = spec.args?.at(-1) ?? ''
    commands.push(command)
    live += 1
    maxLive = Math.max(maxLive, live)
    const exitState: { exitCode: number | null; signalCode: NodeJS.Signals | null } = {
      exitCode: null,
      signalCode: null
    }
    const child = Object.assign(new EventEmitter(), exitState, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => {
        socket.destroy()
        finish(null, 'SIGTERM')
        return true
      }
    })
    let finished = false
    const finish = (code: number | null, signal: NodeJS.Signals | null = null): void => {
      if (finished) {
        return
      }
      finished = true
      live -= 1
      child.exitCode = code
      child.signalCode = signal
      child.emit('exit', code, signal)
      child.stdout.end()
      child.stderr.end()
      setImmediate(() => child.emit('close', code, signal))
    }
    const port = Number(/ (\d+); fi; done;/.exec(command)?.[1] ?? 0)
    const socket = connect({ host: '127.0.0.1', port })
    let connected = false
    socket.on('connect', () => {
      connected = true
      child.stdout.write(`${ORCAD_STDIO_BRIDGE_READY}\n`)
      child.stdin.pipe(socket)
      socket.pipe(child.stdout, { end: false })
    })
    socket.on('error', (error: NodeJS.ErrnoException) => {
      if (!connected) {
        child.stdout.write(`${ORCAD_STDIO_BRIDGE_REFUSED} ${error.code ?? 'ERROR'}\n`)
      }
      finish(0)
    })
    socket.on('close', () => finish(0))
    process.nextTick(() => child.emit('spawn'))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the WSL channel reads only the streams, exit state, kill and events assigned above.
    return child as unknown as PipedChildProcess
  }
  return { spawn, commands, live: () => live, maxLive: () => maxLive }
}

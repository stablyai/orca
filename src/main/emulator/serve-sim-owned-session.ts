import { spawnProcess } from '@orca/process-host'
import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EmulatorError } from './emulator-errors'
import { SERVE_SIM_OWNED_SERVER } from './serve-sim-owned-server'
import { simulatorOwnershipRoot, stopOwnedSimulatorChild } from './serve-sim-owned-process'
import { ownedSimulatorStateRoot, stopOwnedSimulatorHelpers } from './serve-sim-owned-process'
import { ownsSimulatorSession, ownsSimulatorEndpoint } from './serve-sim-owned-process'
import { SimulatorShutdownError } from './simctl-simulator-devices'
import { getServeSimEnv, type ServeSimExecutable } from './serve-sim-execution'
import type { EmulatorSessionInfo } from './emulator-types'

type OwnedSession = {
  info: EmulatorSessionInfo
  child: ChildProcess
  stateRoot: string
  lock: string
  stopping: boolean
  stopInProgress: boolean
}

export class ServeSimOwnedSessions {
  constructor(private readonly ownershipRoot: () => string = simulatorOwnershipRoot) {}

  private readonly sessions = new Map<string, OwnedSession>()
  private readonly starting = new Map<string, Promise<EmulatorSessionInfo>>()

  async start(
    udid: string,
    executable: ServeSimExecutable,
    prepare: () => Promise<void>,
    ready: (info: EmulatorSessionInfo) => Promise<boolean>,
    assertOpen: () => void = () => {}
  ): Promise<EmulatorSessionInfo> {
    assertOpen()
    const current = this.sessions.get(udid)
    if (current?.stopping) {
      throw new EmulatorError(
        'emulator_helper_failed',
        `Simulator ${udid} ownership requires cleanup before reattach.`
      )
    }
    if (current && current.child.exitCode === null && current.child.signalCode === null) {
      if (!(await ready(current.info))) {
        throw new EmulatorError(
          'emulator_helper_failed',
          'The existing simulator helper is not reachable.'
        )
      }
      assertOpen()
      return current.info
    }
    if (current) {
      throw new EmulatorError(
        'emulator_helper_failed',
        `Simulator ${udid} ownership requires cleanup before reattach.`
      )
    }
    const pending = this.starting.get(udid)
    if (pending) {
      return pending
    }
    const start = this.startNew(udid, executable, prepare, ready, assertOpen).finally(() =>
      this.starting.delete(udid)
    )
    this.starting.set(udid, start)
    return start
  }

  private async startNew(
    udid: string,
    executable: ServeSimExecutable,
    prepare: () => Promise<void>,
    ready: (info: EmulatorSessionInfo) => Promise<boolean>,
    assertOpen: () => void
  ): Promise<EmulatorSessionInfo> {
    assertOpen()
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(udid)) {
      throw new EmulatorError('emulator_device_not_found', `Invalid simulator UDID: ${udid}`)
    }
    const entry = executable.baseArgs[0]
    if (!entry) {
      throw new EmulatorError('emulator_helper_failed', 'Cannot locate serve-sim middleware.')
    }
    const lockRoot = this.ownershipRoot()
    mkdirSync(lockRoot, { recursive: true })
    const lock = join(lockRoot, udid.toUpperCase())
    try {
      mkdirSync(lock)
    } catch {
      throw new EmulatorError(
        'emulator_helper_failed',
        `Simulator ${udid} is already claimed or has a stale Orca ownership record at ${lock}.`
      )
    }
    let stateRoot: string | undefined
    let child: ChildProcess | undefined
    try {
      await prepare()
      assertOpen()
      stateRoot = mkdtempSync(join(tmpdir(), 'orca-simulator-session-'))
      const middleware = pathToFileURL(join(dirname(entry), 'middleware.js')).href
      const token = randomUUID()
      child = spawnProcess({
        program: executable.command,
        args: ['-e', SERVE_SIM_OWNED_SERVER, middleware, udid, token],
        env: { ...getServeSimEnv(executable), TMPDIR: stateRoot },
        stdio: ['pipe', 'pipe', 'pipe']
      })
      const ownedChild = child
      const port = await new Promise<number>((resolve, reject) => {
        let output = ''
        let errors = ''
        const fail = (error: Error) => {
          clearTimeout(timer)
          reject(error)
        }
        const timer = setTimeout(
          () => fail(new Error('Timed out starting simulator helper')),
          15_000
        )
        ownedChild.stderr?.on('data', (chunk: Buffer) => {
          errors += chunk.toString()
        })
        ownedChild.once('error', fail)
        ownedChild.once('exit', () => fail(new Error(errors || 'Simulator helper exited')))
        ownedChild.stdout?.on('data', (chunk: Buffer) => {
          output += chunk.toString()
          const match = /(?:^|\n)ORCA_PORT:(\d+)\r?\n/.exec(output)
          const value = Number(match?.[1])
          if (match && Number.isInteger(value) && value > 0 && value < 65536) {
            clearTimeout(timer)
            resolve(value)
          }
        })
      })
      assertOpen()
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
        throw new Error('Simulator helper exited during startup')
      }
      const url = `http://127.0.0.1:${port}`
      const prefix = `/${token}/helper/${udid}`
      const info: EmulatorSessionInfo = {
        deviceUdid: udid,
        helperPid: child.pid,
        streamUrl: `${url}${prefix}/stream.mjpeg`,
        wsUrl: `ws://127.0.0.1:${port}${prefix}/ws`,
        axUrl: `${url}${prefix}/ax`,
        backend: 'ios',
        streamCodec: 'mjpeg'
      }
      mkdirSync(join(stateRoot, 'serve-sim'))
      writeFileSync(
        join(stateRoot, 'serve-sim', `server-${udid}.json`),
        JSON.stringify({
          pid: child.pid,
          port,
          device: udid,
          url,
          streamUrl: info.streamUrl,
          wsUrl: info.wsUrl
        })
      )
      if (!(await ready(info)) || child.exitCode !== null || child.signalCode !== null) {
        throw new EmulatorError(
          'emulator_helper_failed',
          'Simulator helper stream is not reachable.'
        )
      }
      assertOpen()
      const session: OwnedSession = {
        info,
        child,
        stateRoot,
        lock,
        stopping: false,
        stopInProgress: false
      }
      this.sessions.set(udid, session)
      child.once('exit', () => {
        if (session.stopping) {
          return
        }
        if (this.sessions.get(udid) === session) {
          this.sessions.delete(udid)
        }
        try {
          rmSync(session.stateRoot, { recursive: true, force: true })
          rmSync(lock, { recursive: true, force: true })
        } catch {
          // A remaining lock makes a later attach fail closed.
        }
      })
      return info
    } catch (error) {
      if (child && child.pid && child.exitCode === null && child.signalCode === null) {
        try {
          await stopOwnedSimulatorChild(child)
        } catch (stopError) {
          const root = stateRoot
          child.once('exit', () => {
            try {
              if (root) {
                rmSync(root, { recursive: true, force: true })
              }
              rmSync(lock, { recursive: true, force: true })
            } catch {}
          })
          throw stopError
        }
      }
      if (stateRoot) {
        rmSync(stateRoot, { recursive: true, force: true })
      }
      rmSync(lock, { recursive: true, force: true })
      throw new EmulatorError(
        'emulator_helper_failed',
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  owns(info: EmulatorSessionInfo): boolean {
    return ownsSimulatorSession(this.sessions.get(info.deviceUdid), info)
  }

  ownsEndpoint(udid: string, endpoint: string | undefined): boolean {
    return ownsSimulatorEndpoint(this.sessions.get(udid), endpoint)
  }

  stateRoot(udid: string): string {
    return ownedSimulatorStateRoot(this.sessions.get(udid), udid)
  }

  stopOwnedHelpers(): Promise<void> {
    return stopOwnedSimulatorHelpers([...this.sessions.values()], this.stop.bind(this))
  }

  async stop(
    udid: string,
    helperPid?: number,
    shutdown?: () => Promise<void>,
    releaseOnShutdownFailure = false,
    onHelperStopped?: () => void
  ): Promise<void> {
    const session = this.sessions.get(udid)
    if (!session) {
      if (helperPid !== undefined && !shutdown) {
        return
      }
      throw new EmulatorError('emulator_no_active', `No owned simulator helper for ${udid}.`)
    }
    if (helperPid !== undefined && session.info.helperPid !== helperPid) {
      throw new EmulatorError(
        'emulator_helper_failed',
        `Simulator ${udid} helper changed before it could be stopped.`
      )
    }
    if (session.stopInProgress) {
      throw new EmulatorError('emulator_helper_failed', `Simulator ${udid} is already stopping.`)
    }
    session.stopping = true
    session.stopInProgress = true
    let stopped = false
    let shutdownSettled = false
    try {
      await stopOwnedSimulatorChild(session.child)
      stopped = true
      onHelperStopped?.()
      if (shutdown) {
        try {
          await shutdown()
        } finally {
          shutdownSettled = true
        }
      }
      rmSync(session.stateRoot, { recursive: true, force: true })
      rmSync(session.lock, { recursive: true, force: true })
      if (this.sessions.get(udid) === session) {
        this.sessions.delete(udid)
      }
    } catch (error) {
      if (
        releaseOnShutdownFailure &&
        stopped &&
        shutdownSettled &&
        error instanceof SimulatorShutdownError &&
        error.completed
      ) {
        rmSync(session.stateRoot, { recursive: true, force: true })
        rmSync(session.lock, { recursive: true, force: true })
        if (this.sessions.get(udid) === session) {
          this.sessions.delete(udid)
        }
      } else if (session.child.exitCode === null && session.child.signalCode === null) {
        session.stopping = false
      }
      throw error
    } finally {
      session.stopInProgress = false
    }
  }
}

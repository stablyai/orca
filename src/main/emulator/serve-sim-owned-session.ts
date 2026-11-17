import { spawnProcess } from '@orca/process-host'
import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EmulatorError } from './emulator-errors'
import { getServeSimEnv, type ServeSimExecutable } from './serve-sim-execution'
import type { EmulatorSessionInfo } from './emulator-types'

// The public middleware lets the OS allocate the listening port without serve-sim's port-killing CLI.
const SERVER = `
const { createServer } = require('node:http');
(async () => {
  const { simMiddleware } = await import(process.argv[1]);
  const device = process.argv[2];
  const token = '/' + process.argv[3];
  const prefix = token + '/helper/' + device + '/';
  const middleware = simMiddleware({ basePath: '/', device });
  const route = req => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/api/event-log') {
        url.searchParams.set('device', device);
        req.url = url.pathname + url.search;
        return true;
      }
      if (!url.pathname.startsWith(prefix)) return false;
      req.url = url.pathname.slice(token.length) + url.search;
      return true;
    } catch { return false; }
  };
  const server = createServer((req, res) => {
    if (!route(req)) { res.writeHead(404); res.end(); return; }
    Promise.resolve(middleware(req, res)).catch(() => { res.destroy(); });
  });
  server.on('upgrade', (req, socket, head) => {
    if (!route(req)) { socket.destroy(); return; }
    middleware.handleUpgrade(req, socket, head);
  });
  server.listen(0, '127.0.0.1', () => console.log('ORCA_PORT:' + server.address().port));
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
})().catch(error => { console.error(error); process.exit(1); });
`

type OwnedSession = {
  info: EmulatorSessionInfo
  child: ChildProcess
  stateRoot: string
  lock: string
}

export class ServeSimOwnedSessions {
  private readonly sessions = new Map<string, OwnedSession>()
  private readonly starting = new Map<string, Promise<EmulatorSessionInfo>>()

  async start(
    udid: string,
    executable: ServeSimExecutable,
    prepare: () => Promise<void>,
    ready: (info: EmulatorSessionInfo) => Promise<boolean>
  ): Promise<EmulatorSessionInfo> {
    const current = this.sessions.get(udid)
    if (current && current.child.exitCode === null && current.child.signalCode === null) {
      if (!(await ready(current.info))) {
        throw new EmulatorError(
          'emulator_helper_failed',
          'The existing simulator helper is not reachable.'
        )
      }
      return current.info
    }
    const pending = this.starting.get(udid)
    if (pending) {
      return pending
    }
    const start = this.startNew(udid, executable, prepare, ready).finally(() =>
      this.starting.delete(udid)
    )
    this.starting.set(udid, start)
    return start
  }

  private async startNew(
    udid: string,
    executable: ServeSimExecutable,
    prepare: () => Promise<void>,
    ready: (info: EmulatorSessionInfo) => Promise<boolean>
  ): Promise<EmulatorSessionInfo> {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(udid)) {
      throw new EmulatorError('emulator_device_not_found', `Invalid simulator UDID: ${udid}`)
    }
    const entry = executable.baseArgs[0]
    if (!entry) {
      throw new EmulatorError('emulator_helper_failed', 'Cannot locate serve-sim middleware.')
    }
    const lockRoot = join(tmpdir(), 'orca-simulator-ownership')
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
      stateRoot = mkdtempSync(join(tmpdir(), 'orca-simulator-session-'))
      const middleware = pathToFileURL(join(dirname(entry), 'middleware.js')).href
      const token = randomUUID()
      child = spawnProcess({
        program: executable.command,
        args: ['-e', SERVER, middleware, udid, token],
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
      const session: OwnedSession = { info, child, stateRoot, lock }
      this.sessions.set(udid, session)
      child.once('exit', () => {
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
          await this.stopChild(child)
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
    const session = this.sessions.get(info.deviceUdid)
    return (
      !!session &&
      session.info.helperPid === info.helperPid &&
      session.info.streamUrl === info.streamUrl &&
      session.child.exitCode === null &&
      session.child.signalCode === null
    )
  }

  ownsEndpoint(udid: string, endpoint: string | undefined): boolean {
    const session = this.sessions.get(udid)
    return (
      !!session &&
      this.owns(session.info) &&
      (endpoint === session.info.wsUrl || endpoint === session.info.axUrl)
    )
  }

  stateRoot(udid: string): string {
    const session = this.sessions.get(udid)
    if (!session || session.child.exitCode !== null || session.child.signalCode !== null) {
      throw new EmulatorError(
        'emulator_no_active',
        `No owned simulator session for ${udid}; attach it first.`
      )
    }
    return session.stateRoot
  }

  async stop(udid: string, helperPid?: number): Promise<void> {
    const session = this.sessions.get(udid)
    if (!session) {
      if (helperPid !== undefined) {
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
    await this.stopChild(session.child)
  }

  private async stopChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      return
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Simulator helper did not exit; ownership retained.')),
        5_000
      )
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      if (!child.kill()) {
        clearTimeout(timer)
        reject(new Error('Could not stop simulator helper; ownership retained.'))
      }
    })
  }
}

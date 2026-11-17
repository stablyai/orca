import { connect, type Socket } from 'node:net'
import { basename, isAbsolute } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import { hostedProviderOwners } from './hosted-provider-owners'
import {
  HOSTED_PROVIDER_PIPE_FDS,
  type HostedProviderSpawn,
  type HostedProviderSpawnResult
} from '../protocol/daemon-provider-process-protocol'

const CONNECT_TIMEOUT_MS = 5_000
const PROVIDER_OWNER_EXECUTABLE = 'orca-provider-exec'

const launchString = (value: unknown): value is string =>
  typeof value === 'string' && !value.includes('\0')

function validLaunch(spec: HostedProviderSpawn | undefined): spec is HostedProviderSpawn {
  return (
    !!spec &&
    typeof spec.nonce === 'string' &&
    /^[a-f0-9]{64}$/.test(spec.nonce) &&
    launchString(spec.path) &&
    isAbsolute(spec.path) &&
    launchString(spec.program) &&
    isAbsolute(spec.program) &&
    basename(spec.program) === PROVIDER_OWNER_EXECUTABLE &&
    Array.isArray(spec.args) &&
    spec.args.every(launchString) &&
    launchString(spec.cwd) &&
    !!spec.env &&
    typeof spec.env === 'object' &&
    Object.entries(spec.env).every(([key, value]) => launchString(key) && launchString(value))
  )
}

function connectPipe(path: string, nonce: string, fd: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    // The child shares this socket's description: an automatic end on EOF would shut it down there too.
    const socket = connect({ path, allowHalfOpen: true })
    const timer = setTimeout(
      () => fail(new Error('Provider owner connection timed out')),
      CONNECT_TIMEOUT_MS
    )
    const fail = (error: Error): void => {
      clearTimeout(timer)
      socket.destroy()
      reject(error)
    }
    socket.once('error', fail)
    socket.once('connect', () => {
      // The header precedes every byte the owner process writes, so the app reads it first.
      socket.write(`${nonce} ${fd}\n`, (error) => {
        if (error) {
          fail(error)
          return
        }
        clearTimeout(timer)
        socket.off('error', fail)
        socket.on('error', () => {})
        resolve(socket)
      })
    })
  })
}

/** Starts the app's native owner under this host for attribution; the app keeps every pipe end. */
export async function spawnHostedProvider(
  spec: HostedProviderSpawn | undefined,
  accepting: boolean
): Promise<HostedProviderSpawnResult> {
  if (!accepting) {
    throw new Error('Provider host unavailable')
  }
  if (!validLaunch(spec)) {
    throw new Error('Invalid provider launch')
  }
  const pipes = await Promise.allSettled(
    HOSTED_PROVIDER_PIPE_FDS.map((fd) => connectPipe(spec.path, spec.nonce, fd))
  )
  const sockets = pipes.flatMap((pipe) => (pipe.status === 'fulfilled' ? [pipe.value] : []))
  try {
    if (sockets.length !== HOSTED_PROVIDER_PIPE_FDS.length) {
      throw new Error('Provider owner connection failed')
    }
    const child = spawnProcess({
      program: spec.program,
      args: spec.args,
      cwd: spec.cwd,
      env: spec.env,
      detached: true,
      stdio: ['ignore', ...sockets]
    })
    child.on('error', () => {})
    // Its pipes belong to the app; this host only reaps the native parent when it exits.
    const pid = await new Promise<number | NodeJS.ErrnoException>((resolve) => {
      if (child.pid !== undefined) {
        resolve(child.pid)
        return
      }
      child.once('error', resolve)
    })
    if (typeof pid !== 'number') {
      const { code = 'UNKNOWN', path } = pid
      return { spawnError: { code, ...(typeof path === 'string' ? { path } : {}) } }
    }
    hostedProviderOwners.add(pid)
    child.once('exit', () => hostedProviderOwners.delete(pid))
    return { pid }
  } finally {
    // Close only this host's descriptors (never end/shutdown); the app is then the pipes' only owner.
    for (const socket of sockets) {
      socket.destroy()
    }
  }
}

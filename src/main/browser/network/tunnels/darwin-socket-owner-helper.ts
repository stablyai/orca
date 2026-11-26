import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { isIP } from 'node:net'
import { dirname, join } from 'node:path'
import { spawnProcess } from '@orca/process-host'

// Bundled next to the app executable; it names the account holding a loopback connection's client end.
const HELPER_EXECUTABLE = 'orca-socket-owner'
// Lookups take about a millisecond; no answer at all for this long means the helper is stuck.
const STALL_TIMEOUT_MS = 5_000
// Each listener admits at most 256 connections; a deeper queue is a flood, refused without a lookup.
const MAX_PENDING_LOOKUPS = 1_024
// A failed helper is respawned at most this often, so a crash loop can't spawn per connection.
const RESPAWN_BACKOFF_MS = 30_000

type Endpoint = { host: string; port: number }
type Pending = { resolve: (own: boolean) => void; reject: (error: Error) => void }
type RunningHelper = {
  child: ChildProcessWithoutNullStreams
  pending: Pending[]
  buffered: string
  /** Armed while lookups wait; each answer pushes it back, so a deep queue isn't a stall. */
  stall: ReturnType<typeof setTimeout> | null
}

let helperPath = (): string => join(dirname(process.execPath), HELPER_EXECUTABLE)
let available: Promise<boolean> | null = null
let holders = 0
let running: RunningHelper | null = null
// Set when the helper fails; connections are refused until the backoff passes or every listener closes.
let broken: { reason: string; until: number } | null = null

export function darwinSocketOwnerHelperAvailable(): Promise<boolean> {
  available ??= access(helperPath(), constants.X_OK).then(
    () => true,
    () => false
  )
  return available
}

/** Keeps the helper available while a listener is open; the last release stops it. */
export function retainDarwinSocketOwnerHelper(): () => void {
  holders++
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    holders--
    if (holders === 0) {
      stop(running, 'no listener needs the socket owner helper')
      broken = null
    }
  }
}

/** Whether one of this account's processes holds the connection's client end. Rejects when it can't tell. */
export function isOwnDarwinConnection(client: Endpoint, listener: Endpoint): Promise<boolean> {
  if (broken && Date.now() < broken.until) {
    return Promise.reject(new Error(broken.reason))
  }
  if (holders === 0) {
    return Promise.reject(new Error('no listener holds the socket owner helper'))
  }
  if (!isIP(client.host) || !isIP(listener.host)) {
    return Promise.reject(new Error('connection has no IP address'))
  }
  const helper = running ?? start()
  if (helper.pending.length >= MAX_PENDING_LOOKUPS) {
    return Promise.reject(new Error('too many connections are waiting for an owner check'))
  }
  return new Promise((resolve, reject) => {
    helper.pending.push({ resolve, reject })
    helper.stall ??= armStall(helper)
    helper.child.stdin.write(`${client.host} ${client.port} ${listener.host} ${listener.port}\n`)
  })
}

function armStall(helper: RunningHelper): ReturnType<typeof setTimeout> {
  return setTimeout(
    () => fail(helper, 'the macOS socket owner helper stopped answering'),
    STALL_TIMEOUT_MS
  )
}

function start(): RunningHelper {
  const child = spawnProcess({ program: helperPath(), args: [] })
  const helper: RunningHelper = { child, pending: [], buffered: '', stall: null }
  running = helper
  broken = null
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    helper.buffered += chunk
    let newline = helper.buffered.indexOf('\n')
    while (newline !== -1) {
      const answer = helper.buffered.slice(0, newline)
      helper.buffered = helper.buffered.slice(newline + 1)
      const request = helper.pending.shift()
      if (answer === 'own' || answer === 'none') {
        request?.resolve(answer === 'own')
      } else {
        request?.reject(new Error(`the macOS socket owner helper answered "${answer}"`))
      }
      newline = helper.buffered.indexOf('\n')
    }
    if (helper.stall) {
      clearTimeout(helper.stall)
      helper.stall = helper.pending.length > 0 ? armStall(helper) : null
    }
  })
  child.stdin.on('error', (error) =>
    fail(helper, `the macOS socket owner helper: ${error.message}`)
  )
  child.on('error', (error) => fail(helper, `the macOS socket owner helper: ${error.message}`))
  child.on('exit', (code, signal) =>
    fail(helper, `the macOS socket owner helper exited (${signal ?? code})`)
  )
  return helper
}

function fail(helper: RunningHelper, reason: string): void {
  if (running !== helper) {
    return
  }
  broken = { reason, until: Date.now() + RESPAWN_BACKOFF_MS }
  stop(helper, reason)
}

function stop(helper: RunningHelper | null, reason: string): void {
  if (!helper) {
    return
  }
  if (running === helper) {
    running = null
  }
  if (helper.stall) {
    clearTimeout(helper.stall)
  }
  for (const request of helper.pending.splice(0)) {
    request.reject(new Error(reason))
  }
  helper.child.stdin.end()
  helper.child.kill()
}

/** Tests point this at a stand-in helper; resets what the last path said. */
export function setDarwinSocketOwnerHelperPathForTests(path: string | null): void {
  helperPath = () => path ?? join(dirname(process.execPath), HELPER_EXECUTABLE)
  available = null
}

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
type Lookup = {
  request: string
  /** Aborts when the connection closes; a lookup still queued then is dropped unscanned. */
  signal?: AbortSignal
  resolve: (own: boolean) => void
  reject: (error: Error) => void
}
type RunningHelper = {
  child: ChildProcessWithoutNullStreams
  /** Written one at a time, so a lookup whose connection closed while queued is never scanned. */
  queued: Lookup[]
  inFlight: Lookup | null
  buffered: string
  /** Armed while a lookup is in flight; no answer by then means the helper is stuck. */
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
export function isOwnDarwinConnection(
  client: Endpoint,
  listener: Endpoint,
  signal?: AbortSignal
): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.reject(new Error('the connection closed before its owner check'))
  }
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
  if (helper.queued.length + (helper.inFlight ? 1 : 0) >= MAX_PENDING_LOOKUPS) {
    return Promise.reject(new Error('too many connections are waiting for an owner check'))
  }
  return new Promise((resolve, reject) => {
    const lookup: Lookup = {
      request: `${client.host} ${client.port} ${listener.host} ${listener.port}\n`,
      signal,
      resolve,
      reject
    }
    helper.queued.push(lookup)
    signal?.addEventListener('abort', () => dropQueued(helper, lookup), { once: true })
    sendNext(helper)
  })
}

function dropQueued(helper: RunningHelper, lookup: Lookup): void {
  const index = helper.queued.indexOf(lookup)
  if (index !== -1) {
    helper.queued.splice(index, 1)
    lookup.reject(new Error('the connection closed before its owner check'))
  }
}

function sendNext(helper: RunningHelper): void {
  if (helper.inFlight || running !== helper) {
    return
  }
  const next = helper.queued.shift()
  if (!next) {
    return
  }
  helper.inFlight = next
  helper.stall = setTimeout(
    () => fail(helper, 'the macOS socket owner helper stopped answering'),
    STALL_TIMEOUT_MS
  )
  helper.child.stdin.write(next.request)
}

function start(): RunningHelper {
  const child = spawnProcess({ program: helperPath(), args: [] })
  const helper: RunningHelper = { child, queued: [], inFlight: null, buffered: '', stall: null }
  running = helper
  broken = null
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    helper.buffered += chunk
    let newline = helper.buffered.indexOf('\n')
    while (newline !== -1) {
      const answer = helper.buffered.slice(0, newline)
      helper.buffered = helper.buffered.slice(newline + 1)
      const lookup = helper.inFlight
      helper.inFlight = null
      if (helper.stall) {
        clearTimeout(helper.stall)
        helper.stall = null
      }
      if (answer === 'own' || answer === 'none') {
        lookup?.resolve(answer === 'own')
      } else {
        lookup?.reject(new Error(`the macOS socket owner helper answered "${answer}"`))
      }
      newline = helper.buffered.indexOf('\n')
    }
    sendNext(helper)
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
  const lookups = helper.queued.splice(0)
  if (helper.inFlight) {
    lookups.push(helper.inFlight)
    helper.inFlight = null
  }
  for (const lookup of lookups) {
    lookup.reject(new Error(reason))
  }
  helper.child.stdin.end()
  helper.child.kill()
}

/** Tests point this at a stand-in helper; resets what the last path said. */
export function setDarwinSocketOwnerHelperPathForTests(path: string | null): void {
  helperPath = () => path ?? join(dirname(process.execPath), HELPER_EXECUTABLE)
  available = null
}

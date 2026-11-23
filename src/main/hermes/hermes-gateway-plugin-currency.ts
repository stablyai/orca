// Whether the Hermes gateway that runs a profile's tools has loaded this build's Orca plugin. The
// plugin marks each process it loads in (`.loaded-<pid>`, holding its generation); the gateway's
// control socket reloads plugins in place, so a gateway that predates an update needs no restart.
import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import {
  HERMES_PLUGIN_GENERATION,
  HERMES_PLUGIN_LOADED_PREFIX,
  HERMES_PLUGIN_NAME,
  HERMES_SESSION_ENV_DIR
} from './hermes-managed-plugin-source'

const RELOAD_TIMEOUT_MS = 15_000
const IDENTIFY_TIMEOUT_MS = 2_000
const MAX_RESPONSE_BYTES = 512 * 1024

export type HermesGatewayPluginState = 'current' | 'noGateway' | 'stale'

const checks = new Map<string, Promise<HermesGatewayPluginState>>()
/** Gateways already sent a reload this run: one that can't mark itself (an older Hermes, a clashing
 *  plugin) is never reloaded again, since every reload briefly drops every session's env. */
const reloaded = new Set<number>()

/** Reloads the serving gateway's plugins, once per gateway, when it runs an older plugin than this
 *  build's. Concurrent checks of one home share an answer. */
export function ensureHermesGatewayPluginCurrent(home: string): Promise<HermesGatewayPluginState> {
  const pending = checks.get(home)
  if (pending) {
    return pending
  }
  const check = checkGateway(home).finally(() => checks.delete(home))
  checks.set(home, check)
  return check
}

async function checkGateway(home: string): Promise<HermesGatewayPluginState> {
  const pids = await gatewayPids(home)
  if (pids.length === 0) {
    return 'noGateway'
  }
  if (await runsCurrentPlugin(home, pids)) {
    return 'current'
  }
  if (pids.every((pid) => reloaded.has(pid))) {
    return 'stale'
  }
  for (const pid of pids) {
    reloaded.add(pid)
  }
  await reloadGatewayPlugins(home)
  return (await runsCurrentPlugin(home, pids)) ? 'current' : 'stale'
}

/** A profile's own gateway, or the root's when it serves its profiles from there; live ones only.
 *  Without a pid record (a service may unlink it), the gateway's own control socket names it. */
async function gatewayPids(home: string): Promise<number[]> {
  const homes = [home, ...(rootOfProfile(home) ? [rootOfProfile(home)!] : [])]
  const recorded = await Promise.all(
    homes.map(async (candidate) => {
      const record = await readFile(join(candidate, 'gateway.pid'), 'utf-8').catch(() => null)
      const pid = record ? parsePid(record) : null
      return pid !== null && isAlive(pid) ? pid : null
    })
  )
  const live = recorded.filter((pid): pid is number => pid !== null)
  if (live.length > 0) {
    return live
  }
  for (const candidate of homes) {
    const pid = (await queryGateway(candidate, 'identify', {}, IDENTIFY_TIMEOUT_MS))?.pid
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
      return [pid]
    }
  }
  return []
}

function rootOfProfile(home: string): string | null {
  return basename(dirname(home)) === 'profiles' ? dirname(dirname(home)) : null
}

/** Hermes' JSON record, or the bare number older ones wrote. */
function parsePid(record: string): number | null {
  try {
    const parsed: unknown = JSON.parse(record)
    const pid: unknown =
      typeof parsed === 'object' && parsed !== null && 'pid' in parsed ? parsed.pid : parsed
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Alive, but another user's.
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

/** Also drops the marks of processes that ended, so they don't pile up. */
async function runsCurrentPlugin(home: string, gatewayPids: readonly number[]): Promise<boolean> {
  const dir = join(home, 'plugins', HERMES_PLUGIN_NAME, HERMES_SESSION_ENV_DIR)
  const names = await readdir(dir).catch((): string[] => [])
  let current = false
  for (const name of names) {
    if (!name.startsWith(HERMES_PLUGIN_LOADED_PREFIX)) {
      continue
    }
    const pid = Number(name.slice(HERMES_PLUGIN_LOADED_PREFIX.length))
    if (gatewayPids.includes(pid)) {
      const generation = await readFile(join(dir, name), 'utf-8').catch(() => null)
      current ||= generation?.trim() === HERMES_PLUGIN_GENERATION
    } else if (!Number.isInteger(pid) || !isAlive(pid)) {
      await rm(join(dir, name), { force: true }).catch(() => undefined)
    }
  }
  return current
}

/** Hermes' own route: the profile's gateway, else the root gateway serving that profile. */
async function reloadGatewayPlugins(home: string): Promise<void> {
  const root = rootOfProfile(home)
  const answered = await queryGateway(home, 'reload-plugins', { home })
  if (!answered && root) {
    await queryGateway(root, 'reload-plugins', { home })
  }
}

/** One JSON line in, one out (Hermes' control-socket contract); null when nothing answers. */
async function queryGateway(
  home: string,
  verb: string,
  params: Record<string, string>,
  timeoutMs = RELOAD_TIMEOUT_MS
): Promise<Record<string, unknown> | null> {
  const path = await controlSocketPath(home)
  if (!path) {
    return null
  }
  return new Promise((done) => {
    const socket = connect(path)
    let received = ''
    const finish = (result: Record<string, unknown> | null) => {
      clearTimeout(timer)
      socket.destroy()
      done(result)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    socket.setEncoding('utf-8')
    socket.on('connect', () => {
      socket.write(
        `${JSON.stringify({ verb, id: 1, protocol: 1, ...(Object.keys(params).length > 0 ? { params } : {}) })}\n`
      )
    })
    socket.on('data', (chunk: string) => {
      received += chunk
      const end = received.indexOf('\n')
      if (end !== -1 || received.length > MAX_RESPONSE_BYTES) {
        finish(parseAnswer(end === -1 ? '' : received.slice(0, end)))
      }
    })
    socket.on('end', () => finish(parseAnswer(received)))
    socket.on('error', () => finish(null))
  })
}

function parseAnswer(line: string): Record<string, unknown> | null {
  try {
    const answer: unknown = JSON.parse(line)
    if (typeof answer !== 'object' || answer === null || !('ok' in answer) || answer.ok !== true) {
      return null
    }
    const result = 'result' in answer ? answer.result : null
    return typeof result === 'object' && result !== null ? { ...result } : null
  } catch {
    return null
  }
}

/** POSIX: `<home>/gateway.sock`, or the path its pointer file names; Windows: a per-home pipe. */
async function controlSocketPath(home: string): Promise<string | null> {
  if (process.platform === 'win32') {
    // Hermes hashes os.path.normcase(Path(home).resolve()): lower case, backslashes.
    const resolved = (await realpath(home).catch(() => resolve(home))).toLowerCase()
    const hash = createHash('sha256').update(resolved).digest('hex').slice(0, 16)
    return `\\\\.\\pipe\\hermes-gateway-${hash}`
  }
  const direct = join(home, 'gateway.sock')
  if (
    await readdir(home)
      .then((names) => names.includes('gateway.sock'))
      .catch(() => false)
  ) {
    return direct
  }
  const pointer = await readFile(join(home, 'gateway.sock.path'), 'utf-8').catch(() => '')
  return pointer.replace(/^﻿/u, '').trim() || null
}

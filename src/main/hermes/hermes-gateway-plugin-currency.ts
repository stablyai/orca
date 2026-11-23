// Whether the Hermes gateway that runs a profile's tools has loaded this build's Orca plugin. The
// plugin marks each process it loads in (`.loaded-<pid>`, holding its generation); the gateway's
// control socket reloads plugins in place, so a gateway that predates an update needs no restart.
import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { compareAppVersions } from '../../shared/app-lifecycle/identity/app-version'
import {
  getPluginInitSource,
  getPluginManifest,
  HERMES_PLUGIN_GENERATION,
  HERMES_PLUGIN_LOADED_PREFIX,
  HERMES_PLUGIN_MARKER,
  HERMES_PLUGIN_NAME,
  HERMES_SESSION_ENV_DIR
} from './hermes-managed-plugin-source'

const RELOAD_TIMEOUT_MS = 15_000
const IDENTIFY_TIMEOUT_MS = 2_000
/** The first Hermes that gives each session's tools their own environment. */
export const HERMES_SESSION_ENV_MINIMUM = '0.23.1'
const MAX_RESPONSE_BYTES = 512 * 1024

export type HermesGatewayPluginState = 'current' | 'noGateway' | 'stale'

const checks = new Map<string, Promise<HermesGatewayPluginState>>()
/** Each profile's gateway already sent a reload of this build's plugin this run: one that still
 *  can't mark itself (a clashing plugin) isn't reloaded again, since every reload briefly drops
 *  every session's env. Hermes reloads one profile per request, so the key names both. */
const reloaded = new Set<string>()

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
  const gateway = await servingGateway(home)
  if (!gateway) {
    return 'noGateway'
  }
  if (await runsCurrentPlugin(home, gateway.pid)) {
    return 'current'
  }
  // A reload loads what is on disk: an older Orca's copy there (this build's install may not
  // have run yet) is replaced first, and a plugin Orca doesn't manage is never reloaded.
  const key = `${home}\0${gateway.pid}`
  if (reloaded.has(key) || !(await pluginFilesCurrent(home))) {
    return 'stale'
  }
  // A gateway running a Hermes without per-session env can't mark itself however often it reloads.
  const running = (await queryGateway(gateway.home, 'identify', {}, IDENTIFY_TIMEOUT_MS))
    ?.code_version
  if (typeof running === 'string' && compareAppVersions(running, HERMES_SESSION_ENV_MINIMUM) < 0) {
    return 'stale'
  }
  reloaded.add(key)
  await reloadGatewayPlugins(home)
  return (await runsCurrentPlugin(home, gateway.pid)) ? 'current' : 'stale'
}

/** The profile's own gateway, else the root's when it serves its profiles from there: by its pid
 *  record, or (a service may unlink that) its control socket's answer. */
async function servingGateway(home: string): Promise<{ home: string; pid: number } | null> {
  const root = rootOfProfile(home)
  for (const candidate of root ? [home, root] : [home]) {
    const record = await readFile(join(candidate, 'gateway.pid'), 'utf-8').catch(() => null)
    const recorded = record ? parsePid(record) : null
    if (recorded !== null && isAlive(recorded)) {
      return { home: candidate, pid: recorded }
    }
    const pid = (await queryGateway(candidate, 'identify', {}, IDENTIFY_TIMEOUT_MS))?.pid
    if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
      return { home: candidate, pid }
    }
  }
  return null
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
async function runsCurrentPlugin(home: string, gatewayPid: number): Promise<boolean> {
  const dir = join(home, HERMES_SESSION_ENV_DIR)
  const names = await readdir(dir).catch((): string[] => [])
  let current = false
  for (const name of names) {
    if (!name.startsWith(HERMES_PLUGIN_LOADED_PREFIX)) {
      continue
    }
    const pid = Number(name.slice(HERMES_PLUGIN_LOADED_PREFIX.length))
    if (pid === gatewayPid) {
      const generation = await readFile(join(dir, name), 'utf-8').catch(() => null)
      current ||= generation?.trim() === HERMES_PLUGIN_GENERATION
    } else if (!Number.isInteger(pid) || !isAlive(pid)) {
      await rm(join(dir, name), { force: true }).catch(() => undefined)
    }
  }
  return current
}

async function pluginFilesCurrent(home: string): Promise<boolean> {
  const dir = join(home, 'plugins', HERMES_PLUGIN_NAME)
  const [manifest, init] = await Promise.all(
    ['plugin.yaml', '__init__.py'].map((name) =>
      readFile(join(dir, name), 'utf-8').catch(() => null)
    )
  )
  // Orca owns the plugin only when both files say so (as getPluginFilesState decides).
  if (!manifest?.includes(HERMES_PLUGIN_MARKER) || !init?.includes(HERMES_PLUGIN_MARKER)) {
    return false
  }
  if (!init.includes(HERMES_PLUGIN_GENERATION)) {
    await writeFile(join(dir, 'plugin.yaml'), getPluginManifest(), 'utf-8')
    await writeFile(join(dir, '__init__.py'), getPluginInitSource(), 'utf-8')
  }
  return true
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

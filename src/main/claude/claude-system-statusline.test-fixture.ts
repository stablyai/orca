import * as fs from 'node:fs/promises'
import type * as syncFs from 'node:fs'
import * as os from 'node:os'
import type * as childProcess from 'node:child_process'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import type { applyAgentStatusHooksEnabled as ApplyManagedHooks } from '../agent-hooks/managed-agent-hook-controls'
const seam = vi.hoisted(
  (): {
    home: string
    before: null | ((method: string, path: string) => Promise<void>)
    after: null | ((method: string, path: string) => Promise<void>)
    calls: Map<string, number> | null
    bytes: Map<string, number> | null
    probes: number
    nativeBirth: null | ((pid: number) => number | null)
    cim: null | (() => Promise<{ stdout: string; stderr: string }>)
    online: boolean
    unavailableHost: boolean
    zeroParent: string | null
    syncAfter: null | ((method: string, path: string) => void)
  } => ({
    home: '',
    before: null,
    after: null,
    calls: null,
    bytes: null,
    probes: 0,
    nativeBirth: null,
    cim: null,
    online: true,
    unavailableHost: false,
    zeroParent: null,
    syncAfter: null
  })
)
vi.mock('node:child_process', async (original) => {
  const { promisify } = await import('node:util')
  const actual = await original<typeof childProcess>()
  const originalAsync = promisify(actual.execFile)
  const execFile = vi.fn((...args: Parameters<typeof actual.execFile>) => {
    seam.probes++
    return actual.execFile(...args)
  })
  Object.defineProperty(execFile, promisify.custom, {
    value: (...args: Parameters<typeof originalAsync>) => {
      seam.probes++
      if (seam.cim && String(args[0]).endsWith('powershell.exe')) {
        return seam.cim()
      }
      if (seam.nativeBirth && String(args[0]).endsWith('reg.exe')) {
        return Promise.resolve({ stdout: 'MachineGuid REG_SZ fixture-host', stderr: '' })
      }
      if (seam.unavailableHost && (args[0] === 'ioreg' || String(args[0]).endsWith('reg.exe'))) {
        throw new Error('Host probe unavailable')
      }
      return originalAsync(...args)
    }
  })
  return { ...actual, execFile }
})
vi.mock('node:os', async (original) => ({
  ...(await original<typeof os>()),
  homedir: () => seam.home
}))
vi.mock('electron', () => ({ app: { getPath: () => seam.home } }))
vi.mock('../agent-hooks/local-agent-cli-presence', () => ({
  detectLocalManagedAgentCliPresence: async () => ({
    claude: { state: 'found' },
    gemini: { state: 'found' }
  })
}))
vi.mock('../../cli/runtime-client', () => ({
  RuntimeClient: class {
    getOfflineRuntimeAdmission = async () => ({
      reachable: seam.online,
      legacyPidRunning: seam.online,
      pid: seam.online ? process.pid : null
    })
    call = async () => ({ result: { settings: {} } })
  },
  RuntimeClientError: Error,
  getDefaultUserDataPath: () => join(seam.home, 'data')
}))
vi.mock('../../cli/profile-state-location', () => ({
  getActiveProfileStateLocation: () => undefined
}))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>()
  async function observe<T>(
    method: string,
    path: syncFs.PathLike | fs.FileHandle,
    run: () => Promise<T>,
    data?: string | NodeJS.ArrayBufferView
  ) {
    const name = String(path)
    const key = `${method}:${name}`
    seam.calls?.set(key, (seam.calls.get(key) ?? 0) + 1)
    await seam.before?.(method, name)
    if (seam.unavailableHost && name.startsWith('/var/tmp/orca-managed-hooks-')) {
      throw new Error('Host token storage unavailable')
    }
    const result = await run()
    if (
      method === 'stat' &&
      name === seam.zeroParent &&
      typeof result === 'object' &&
      result !== null
    ) {
      Reflect.set(result, 'dev', 0n)
      Reflect.set(result, 'ino', 0n)
    }
    const payload = method === 'readFile' ? result : data
    if (typeof payload === 'string' || Buffer.isBuffer(payload)) {
      seam.bytes?.set(key, (seam.bytes.get(key) ?? 0) + Buffer.byteLength(payload))
    }
    await seam.after?.(method, name)
    return result
  }
  return {
    ...actual,
    readFile: (...args: Parameters<typeof actual.readFile>) =>
      observe('readFile', args[0], () => actual.readFile(...args)),
    realpath: (...args: Parameters<typeof actual.realpath>) =>
      observe('realpath', args[0], () => actual.realpath(...args)),
    stat: (...args: Parameters<typeof actual.stat>) =>
      observe('stat', args[0], () => actual.stat(...args)),
    lstat: (...args: Parameters<typeof actual.lstat>) =>
      observe('lstat', args[0], () => actual.lstat(...args)),
    rename: (...args: Parameters<typeof actual.rename>) =>
      observe('rename', args[1], () => actual.rename(...args)),
    rm: (...args: Parameters<typeof actual.rm>) => observe('rm', args[0], () => actual.rm(...args)),
    writeFile: (...args: Parameters<typeof actual.writeFile>) =>
      observe(
        'writeFile',
        args[0],
        () => actual.writeFile(...args),
        typeof args[1] === 'string' || Buffer.isBuffer(args[1]) ? args[1] : undefined
      ),
    readdir: (...args: Parameters<typeof actual.readdir>) =>
      observe('readdir', args[0], () => actual.readdir(...args)),
    link: (...args: Parameters<typeof actual.link>) =>
      observe('link', args[1], () => actual.link(...args)),
    copyFile: (...args: Parameters<typeof actual.copyFile>) =>
      observe('copyFile', args[1], async () => {
        const result = await actual.copyFile(...args)
        const key = `copyFile:${String(args[1])}`
        if (seam.bytes) {
          seam.bytes.set(key, (seam.bytes.get(key) ?? 0) + (await actual.stat(args[0])).size)
        }
        return result
      }),
    mkdir: (...args: Parameters<typeof actual.mkdir>) =>
      observe('mkdir', args[0], () => actual.mkdir(...args)),
    chmod: (...args: Parameters<typeof actual.chmod>) =>
      observe('chmod', args[0], () => actual.chmod(...args))
  }
})
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof syncFs>()
  function observe<T>(
    method: string,
    path: syncFs.PathOrFileDescriptor,
    run: () => T,
    data?: unknown
  ) {
    const key = `${method}:${String(path)}`
    seam.calls?.set(key, (seam.calls.get(key) ?? 0) + 1)
    const result = run()
    seam.syncAfter?.(method, String(path))
    const payload = method === 'readFileSync' ? result : data
    if (typeof payload === 'string' || Buffer.isBuffer(payload)) {
      seam.bytes?.set(key, (seam.bytes.get(key) ?? 0) + Buffer.byteLength(payload))
    }
    return result
  }
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) =>
      observe('readFileSync', args[0], () => actual.readFileSync(...args)),
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) =>
      observe('writeFileSync', args[0], () => actual.writeFileSync(...args), args[1]),
    copyFileSync: (...args: Parameters<typeof actual.copyFileSync>) =>
      observe('copyFileSync', args[1], () => actual.copyFileSync(...args)),
    renameSync: (...args: Parameters<typeof actual.renameSync>) =>
      observe('renameSync', args[1], () => actual.renameSync(...args))
  }
})
import { ClaudeHookService } from './hook-service'
import { getStatusLineSlotState } from './hook-settings'
export async function applyAgentStatusHooksEnabled(...args: Parameters<typeof ApplyManagedHooks>) {
  return await (
    await import('../agent-hooks/managed-agent-hook-controls')
  ).applyAgentStatusHooksEnabled(...args)
}
export const main = async (args: string[]) => await (await import('../../cli/index')).main(args)
export function slot(config: Parameters<typeof getStatusLineSlotState>[0]) {
  return getStatusLineSlotState(config)
}
export const current = { claudeVersion: '2.1.261' }
let Service = ClaudeHookService
export const service = () => new Service()
export const file = (name: string) => join(seam.home, name, 'settings.json')
export const read = async (path: string) => JSON.parse(await fs.readFile(path, 'utf8'))
export const write = async (path: string, config: Parameters<typeof getStatusLineSlotState>[0]) => {
  await fs.mkdir(dirname(path), { recursive: true })
  await fs.writeFile(path, JSON.stringify(config))
}
export const install = (name: string, options = current) =>
  service().installSystem({
    ...options,
    target: { kind: 'system-default', configDir: dirname(file(name)) }
  })
export const remove = (name: string) =>
  service().removeSystem({ target: { kind: 'system-default', configDir: dirname(file(name)) } })
export const erase = async (name: string) => {
  const config = await read(file(name))
  delete config.statusLine
  await write(file(name), config)
}
export const storage = () => join(seam.home, '.orca/agent-hooks/claude-statusline')
export const documentPath = async () =>
  join(
    storage(),
    (await fs.readdir(storage())).find((name) => name.endsWith('.json'))!
  )
export const document = async () => read(await documentPath())
export const failure = () =>
  Object.assign(new Error('injected storage failure'), { code: 'EACCES' })
beforeEach(async () => {
  seam.online = true
  seam.home = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), 'pr31199-sl-')))
  vi.stubEnv('HOME', seam.home)
  vi.stubEnv('USERPROFILE', seam.home)
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
  vi.stubEnv('ORCA_CLAUDE_INJECTED_CONFIG_DIR', '')
  vi.stubEnv('ORCA_USER_DATA_PATH', join(seam.home, 'data'))
  vi.stubEnv('XDG_CONFIG_HOME', join(seam.home, '.config'))
  vi.stubEnv('APPDATA', join(seam.home, 'AppData/Roaming'))
  vi.stubEnv('CODEX_HOME', join(seam.home, '.codex'))
  vi.stubEnv('ORCA_CODEX_HOME', join(seam.home, '.codex'))
  await resetService()
})
afterEach(async () => {
  seam.before = seam.after = null
  seam.calls = seam.bytes = null
  seam.unavailableHost = false
  seam.nativeBirth = seam.cim = null
  seam.zeroParent = null
  seam.syncAfter = null
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  process.exitCode = undefined
  await fs.rm(seam.home, { recursive: true, force: true })
})

export { seam }
export async function resetService() {
  vi.resetModules()
  Service = (await import('./hook-service')).ClaudeHookService
}

export async function pausedEdit(
  boundary: (method: string, path: string) => boolean,
  operation: () => ReturnType<typeof install>,
  edit: () => Promise<void>
) {
  const entered = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  let held = false
  let expired = false
  const emergency = setTimeout(() => {
    expired = true
    released.resolve()
    entered.resolve()
  }, 3000)
  seam.before = async (method, path) => {
    if (!held && boundary(method, path)) {
      held = true
      entered.resolve()
      await released.promise
    }
  }
  const pending = operation()
  try {
    await entered.promise
    expect(held).toBe(true)
    expect(expired).toBe(false)
    await edit()
    released.resolve()
    const result = await pending
    expect(expired).toBe(false)
    return result
  } finally {
    released.resolve()
    await pending
    clearTimeout(emergency)
    seam.before = null
  }
}

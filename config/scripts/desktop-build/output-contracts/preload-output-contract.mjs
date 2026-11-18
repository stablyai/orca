import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as events from 'node:events'
import * as timers from 'node:timers'
import * as url from 'node:url'
import { runInNewContext } from 'node:vm'
import { verifySandboxPreloadImports } from './sandbox-preload-imports.mjs'

export async function verifyPreloadSource(source) {
  const exposed = new Map()
  const calls = []
  const ipcRenderer = {
    invoke: async (channel, ...args) => {
      calls.push([channel, ...args])
      return { channel }
    },
    on: () => {},
    once: () => {},
    removeListener: () => {},
    send: () => {},
    sendSync: () => {}
  }
  const electron = {
    contextBridge: { exposeInMainWorld: (name, api) => exposed.set(name, api) },
    ipcRenderer,
    webUtils: { getPathForFile: () => '' }
  }
  const modules = new Map([
    ['electron', electron],
    ['electron/common', electron],
    ['electron/renderer', electron],
    ['events', events],
    ['node:events', events],
    ['timers', timers],
    ['node:timers', timers],
    ['url', url],
    ['node:url', url]
  ])
  const imports = await verifySandboxPreloadImports(source)
  const sandbox = {
    process: { contextIsolated: true, platform: process.platform, versions: {}, env: {}, argv: [] },
    require: (name) => {
      if (!modules.has(name)) {
        throw new Error(`Unsupported sandbox module: ${name}`)
      }
      return modules.get(name)
    },
    Buffer,
    TextEncoder,
    TextDecoder,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    window: {},
    document: { addEventListener: () => {} }
  }
  runInNewContext(source, sandbox, {
    filename: 'preload.cjs',
    timeout: 1000,
    contextCodeGeneration: { strings: false, wasm: false }
  })
  const api = exposed.get('api')
  if (
    typeof api?.app?.getIdentity !== 'function' ||
    typeof api?.orcaProfiles?.list !== 'function'
  ) {
    throw new Error('Sandbox preload did not publish executable app/profile APIs')
  }
  for (const [call, channel] of [
    [() => api.app.getIdentity(), 'app:getIdentity'],
    [() => api.orcaProfiles.list(), 'orcaProfiles:list']
  ]) {
    const result = await call()
    if (result?.channel !== channel) {
      throw new Error(`Sandbox API did not return the ${String(channel)} bridge result`)
    }
  }
  if (JSON.stringify(calls) !== JSON.stringify([['app:getIdentity'], ['orcaProfiles:list']])) {
    throw new Error('Sandbox API invocation changed IPC channels or arguments')
  }
  return { imports }
}

export async function verifyPreloadOutput(root = process.cwd()) {
  const directory = path.join(root, 'out', 'preload')
  const scripts = fs
    .readdirSync(directory, { recursive: true })
    .filter((name) => /\.(?:c?js|mjs)$/.test(name))
  if (scripts.length !== 1 || scripts[0] !== 'index.js') {
    throw new Error(`Sandbox preload requires one complete artifact, found: ${scripts.join(', ')}`)
  }
  const result = await verifyPreloadSource(
    fs.readFileSync(path.join(directory, 'index.js'), 'utf8')
  )
  console.log(`Sandbox preload verified: index.js; imports=${result.imports.join(', ')}`)
  return result
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await verifyPreloadOutput()
}

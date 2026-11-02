// Simulate installed-app --serve: read --user-data-dir, listen locally and publish orca-runtime.json.
// Test controls: ORCA_FAKE_SIDECAR_LOG records requests; _CONTROL supplies capabilities/errors;
// _MODE=exit-before-ready exits without publishing metadata.
'use strict'

const { createServer } = require('node:net')
const { appendFileSync, readFileSync, renameSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const USER_DATA_FLAG = '--user-data-dir='
const userDataDir = (
  process.argv.slice(2).find((arg) => arg.startsWith(USER_DATA_FLAG)) ?? ''
).slice(USER_DATA_FLAG.length)
const logPath = process.env.ORCA_FAKE_SIDECAR_LOG
const controlPath = process.env.ORCA_FAKE_SIDECAR_CONTROL

if (!userDataDir) {
  process.stderr.write('fake sidecar: missing --user-data-dir\n')
  process.exit(2)
}
if (process.env.ORCA_FAKE_SIDECAR_MODE === 'exit-before-ready') {
  process.exit(3)
}

function control() {
  try {
    return JSON.parse(readFileSync(controlPath, 'utf8'))
  } catch {
    return {}
  }
}

const tabs = new Map()
let nextSidecarPageId = 0
let statusCalls = 0

function createTab() {
  const browserPageId = `sidecar-${++nextSidecarPageId}`
  for (const tab of tabs.values()) {
    tab.active = false
  }
  tabs.set(browserPageId, { browserPageId, active: true, url: 'about:blank' })
  return browserPageId
}

function activate(browserPageId) {
  for (const tab of tabs.values()) {
    tab.active = tab.browserPageId === browserPageId
  }
}

function handle(method, params) {
  const injected = (control().errors ?? {})[method]
  if (injected) {
    const error = new Error(injected.message)
    error.code = injected.code
    throw error
  }
  if (method === 'status.get') {
    statusCalls += 1
    const schedule = control().capabilities ?? [['browser.headless.v1']]
    return { capabilities: schedule[Math.min(statusCalls - 1, schedule.length - 1)] }
  }
  if (method === 'browser.tabCreate') {
    return { browserPageId: createTab() }
  }
  if (method === 'browser.tabProfileClone') {
    return { browserPageId: createTab(), sourceBrowserPageId: params.page }
  }
  if (method === 'browser.tabList') {
    return { tabs: [...tabs.values()] }
  }
  if (method === 'browser.tabShow' || method === 'browser.tabSwitch') {
    activate(params.page)
    return { browserPageId: params.page }
  }
  if (method === 'browser.tabClose') {
    tabs.delete(params.page)
    return { closed: true }
  }
  if (method === 'browser.goto') {
    const tab = tabs.get(params.page)
    if (tab) {
      tab.url = params.url
    }
    return { browserPageId: params.page, url: params.url, title: 'Fake page' }
  }
  return control().results?.[method] ?? { browserPageId: params.page ?? undefined, method }
}

const endpoint =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\orcad-fake-sidecar-${process.pid}`
    : join(userDataDir, 'rpc.sock')

const server = createServer((socket) => {
  socket.setEncoding('utf8')
  socket.on('error', () => undefined)
  let buffer = ''
  socket.on('data', (chunk) => {
    // setEncoding makes chunks strings, but declared types retain Buffer; normalize for typed lint.
    buffer += String(chunk)
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (!line.trim()) {
        continue
      }
      const request = JSON.parse(line)
      if (logPath) {
        appendFileSync(
          logPath,
          `${JSON.stringify({
            method: request.method,
            params: request.params ?? null,
            authToken: request.authToken ?? null
          })}\n`
        )
      }
      let response
      try {
        response = {
          id: request.id,
          ok: true,
          result: handle(request.method, request.params ?? {})
        }
      } catch (error) {
        response = {
          id: request.id,
          ok: false,
          error: { code: error.code ?? 'browser_error', message: error.message }
        }
      }
      socket.write(`${JSON.stringify(response)}\n`)
    }
  })
})

server.listen(endpoint, () => {
  const metadataPath = join(userDataDir, 'orca-runtime.json')
  // Publish atomically so polling cannot parse partial metadata.
  writeFileSync(
    `${metadataPath}.staging`,
    JSON.stringify({
      runtimeId: `fake-sidecar-${process.pid}`,
      pid: process.pid,
      transports: [{ kind: process.platform === 'win32' ? 'named-pipe' : 'unix', endpoint }],
      authToken: 'fake-sidecar-auth-token',
      startedAt: Date.now()
    })
  )
  renameSync(`${metadataPath}.staging`, metadataPath)
})

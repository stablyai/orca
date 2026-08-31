import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { resolveElectronProbeLaunch } from './electron-probe-display-launch'

const electronBinary = createRequire(import.meta.url)('electron') as string
const fixtureRoots: string[] = []

type ProbeResult = {
  packets: number
  policy: string
  resolvedProxy: string
}

afterAll(() => {
  const failures: unknown[] = []
  for (const root of fixtureRoots) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Failed to clean up WebRTC egress fixtures')
  }
})

function probeMain(resultPath: string, protectedGuest: boolean): string {
  return `
const { app, BrowserWindow, session } = require('electron')
const dgram = require('node:dgram')
const net = require('node:net')
const os = require('node:os')
const { writeFileSync } = require('node:fs')

function bind(socket, host) {
  return new Promise((resolve, reject) => {
    socket.once('error', reject)
    socket.bind(0, host, () => {
      socket.off('error', reject)
      resolve(socket.address())
    })
  })
}

function listen(server, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, () => {
      server.off('error', reject)
      resolve(server.address())
    })
  })
}

function viewerAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return '127.0.0.1'
}

async function probe() {
  const udp = dgram.createSocket('udp4')
  const tcp = net.createServer((socket) => socket.destroy())
  const packets = []
  udp.on('message', (message) => packets.push(message.length))
  const [udpAddress, tcpAddress] = await Promise.all([
    bind(udp, '0.0.0.0'),
    listen(tcp, '127.0.0.1')
  ])
  const partition = 'persist:webrtc-egress-${protectedGuest}-' + Date.now()
  const routeSession = session.fromPartition(partition, { cache: false })
  await routeSession.setProxy({
    mode: 'fixed_servers',
    proxyRules: 'socks5://127.0.0.1:' + tcpAddress.port,
    proxyBypassRules: '<-loopback>'
  })
  await routeSession.closeAllConnections()
  const resolvedProxy = await routeSession.resolveProxy('https://example.invalid/')
  const window = new BrowserWindow({
    show: false,
    webPreferences: { partition, sandbox: true, nodeIntegration: false, contextIsolation: true }
  })
  if (${protectedGuest}) {
    window.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  }
  const policy = window.webContents.getWebRTCIPHandlingPolicy()
  await window.loadURL('data:text/html,<title>WebRTC egress probe</title>')
  const target = viewerAddress()
  const script = \`
    (async () => {
      const peer = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:\${target}:\${udpAddress.port}' }],
        iceCandidatePoolSize: 1
      })
      peer.createDataChannel('probe')
      const offer = await peer.createOffer()
      await peer.setLocalDescription(offer)
      await new Promise(resolve => setTimeout(resolve, 3000))
      peer.close()
    })()
  \`
  await window.webContents.executeJavaScript(script)
  await new Promise((resolve) => setTimeout(resolve, 500))
  window.destroy()
  udp.close()
  tcp.close()
  return { packets: packets.length, policy, resolvedProxy }
}

async function run() {
  const timeout = setTimeout(() => app.exit(2), 20000)
  await app.whenReady()
  const result = await probe()
  writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(result))
  clearTimeout(timeout)
  app.quit()
}

run().catch((error) => {
  writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ error: String(error?.stack || error) }))
  app.exit(1)
})
`
}

function runProbe(protectedGuest: boolean): ProbeResult {
  const root = mkdtempSync(join(tmpdir(), 'orca-browser-webrtc-egress-'))
  fixtureRoots.push(root)
  const mainPath = join(root, 'main.cjs')
  const resultPath = join(root, 'result.json')
  writeFileSync(mainPath, probeMain(resultPath, protectedGuest))
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...env } = process.env
  const electronArgs = [mainPath, `--user-data-dir=${join(root, 'profile')}`]
  const { executable, args } = resolveElectronProbeLaunch({
    electronBinary,
    electronArgs,
    platform: process.platform,
    display: env.DISPLAY
  })
  const run = spawnSync(executable, args, { encoding: 'utf8', env, timeout: 30_000 })
  const rawResult = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : 'no result'
  expect(run.error).toBeUndefined()
  expect(run.status, `${rawResult}\n${run.stdout}\n${run.stderr}`).toBe(0)
  if (rawResult === 'no result') {
    throw new Error(`${rawResult}\n${run.stdout}\n${run.stderr}`)
  }
  const parsed = JSON.parse(rawResult) as ProbeResult | { error: string }
  if ('error' in parsed) {
    throw new Error(parsed.error)
  }
  return parsed
}

describe('browser route WebRTC egress under Electron', () => {
  it('blocks direct UDP after applying the exact guest policy', () => {
    const baseline = runProbe(false)
    const protectedGuest = runProbe(true)

    expect(protectedGuest.resolvedProxy).toMatch(/^SOCKS5 127\.0\.0\.1:\d+$/)
    expect(baseline.packets).toBeGreaterThan(0)
    expect(protectedGuest.policy).toBe('disable_non_proxied_udp')
    expect(protectedGuest.packets).toBe(0)
  }, 45_000)
})

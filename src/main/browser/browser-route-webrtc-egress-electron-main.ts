export function browserRouteWebrtcEgressElectronMain(): string {
  return String.raw`
const { app, BrowserWindow, session } = require('electron')
const dgram = require('node:dgram')
const net = require('node:net')
const os = require('node:os')
const { readFileSync, writeFileSync } = require('node:fs')
const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))

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

function iceScript(stunUrl) {
  return [
    "(async () => {",
    "  const peer = new RTCPeerConnection({",
    "    iceServers: [{ urls: '" + stunUrl + "' }],",
    "    iceCandidatePoolSize: 1",
    "  })",
    "  peer.createDataChannel('probe')",
    "  const offer = await peer.createOffer()",
    "  await peer.setLocalDescription(offer)",
    "  await new Promise(resolve => setTimeout(resolve, 3000))",
    "  peer.close()",
    "})()"
  ].join('\n')
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
  const partition = 'persist:webrtc-egress-' + config.protectedGuest + '-' + Date.now()
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
  if (config.protectedGuest) {
    window.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  }
  const policy = window.webContents.getWebRTCIPHandlingPolicy()
  await window.loadURL('data:text/html,<title>WebRTC egress probe</title>')
  const target = viewerAddress()
  await window.webContents.executeJavaScript(
    iceScript('stun:' + target + ':' + udpAddress.port)
  )
  await new Promise((resolve) => setTimeout(resolve, 500))
  window.destroy()
  udp.close()
  tcp.close()
  return { packets: packets.length, policy, resolvedProxy }
}

async function run() {
  // Why: armed after whenReady so the budget bounds the probe, not Electron's cold start. Startup is the term that
  // dilates when five probes race one runner, and a process that never becomes ready is the launcher's to end.
  await app.whenReady()
  const timeout = setTimeout(() => {
    writeFileSync(config.resultPath, JSON.stringify({ error: 'webrtc_egress_probe_exceeded_budget' }))
    app.exit(2)
  }, 20000)
  const result = await probe()
  // Why disarm first: a watchdog that fires between the probe resolving and the write would clobber a good result.
  clearTimeout(timeout)
  writeFileSync(config.resultPath, JSON.stringify(result))
  app.quit()
}

run().catch((error) => {
  writeFileSync(config.resultPath, JSON.stringify({ error: String(error?.stack || error) }))
  app.exit(1)
})
`
}

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const mobileBundleId = 'com.stably.orca.mobile'
const networkProbePortKey = 'ORCA_E2E_MOBILE_WEB_NETWORK_PROBE_PORT'
const networkProbeTokenKey = 'ORCA_E2E_MOBILE_WEB_NETWORK_PROBE_TOKEN'

export function startHostedWebViewSecurityProbe() {
  const observations = []
  const server = createServer((request, response) => {
    observations.push(`http:${request.url ?? ''}`)
    response.writeHead(204).end()
  })
  server.on('upgrade', (request, socket) => {
    observations.push(`websocket:${request.url ?? ''}`)
    socket.destroy()
  })
  server.on('connection', () => {
    observations.push('tcp:connection')
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('No network probe port'))
        return
      }
      resolve({
        observations,
        port: address.port,
        reset: () => observations.splice(0),
        token: randomUUID().toUpperCase(),
        stop: () => new Promise((stopResolve) => server.close(() => stopResolve()))
      })
    })
  })
}

export const startHostedIosWebViewSecurityProbe = startHostedWebViewSecurityProbe

export async function configureHostedIosWebViewSecurityProbe(deviceUdid, probe) {
  await execFileAsync('xcrun', [
    'simctl',
    'spawn',
    deviceUdid,
    'launchctl',
    'setenv',
    networkProbePortKey,
    String(probe.port)
  ])
  await execFileAsync('xcrun', [
    'simctl',
    'spawn',
    deviceUdid,
    'launchctl',
    'setenv',
    networkProbeTokenKey,
    probe.token
  ])
  await execFileAsync('xcrun', ['simctl', 'terminate', deviceUdid, mobileBundleId]).catch(() => {})
}

export async function clearHostedIosWebViewSecurityProbe(deviceUdid) {
  for (const key of [networkProbePortKey, networkProbeTokenKey]) {
    await execFileAsync('xcrun', [
      'simctl',
      'spawn',
      deviceUdid,
      'launchctl',
      'unsetenv',
      key
    ]).catch(() => {})
  }
}

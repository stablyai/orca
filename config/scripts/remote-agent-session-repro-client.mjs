#!/usr/bin/env node

import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const { parsePairingCode } = require(path.join(repoRoot, 'out', 'shared', 'pairing.js'))
const { RemoteRuntimeRequestConnection } = require(
  path.join(repoRoot, 'out', 'shared', 'remote-runtime-request-connection.js')
)

const [pairingCode, method, rawParams, responseMode] = process.argv.slice(2)
const pairing = pairingCode ? parsePairingCode(pairingCode) : null
if (!pairing || !method || rawParams === undefined) {
  console.error(
    'usage: remote-agent-session-repro-client <pairing> <method> <json-params> [drop-response]'
  )
  process.exit(2)
}

const connection = new RemoteRuntimeRequestConnection(pairing)
let droppedResponse = false
if (responseMode === 'drop-response') {
  if (typeof connection.handleRpcFrame !== 'function') {
    throw new Error('response-loss seam is unavailable')
  }
  connection.handleRpcFrame = () => {
    droppedResponse = true
    connection.close(new Error('repro dropped committed response before caller acknowledgement'))
  }
}
try {
  const response = await connection.request(method, JSON.parse(rawParams), 20_000)
  process.stdout.write(`${JSON.stringify(response)}\n`)
  if (!response.ok) {
    process.exitCode = 1
  }
} catch (error) {
  if (!droppedResponse) {
    throw error
  }
  process.stdout.write(`${JSON.stringify({ ok: true, droppedResponse: true })}\n`)
} finally {
  connection.close()
}

#!/usr/bin/env node

import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const { parsePairingCode } = require(path.join(repoRoot, 'out', 'shared', 'pairing.js'))
const { RemoteRuntimeRequestConnection } = require(
  path.join(repoRoot, 'out', 'shared', 'remote-runtime-request-connection.js')
)

const [pairingCode, method, rawParams] = process.argv.slice(2)
const pairing = pairingCode ? parsePairingCode(pairingCode) : null
if (!pairing || !method || rawParams === undefined) {
  console.error('usage: remote-agent-session-repro-client <pairing> <method> <json-params>')
  process.exit(2)
}

const connection = new RemoteRuntimeRequestConnection(pairing)
try {
  const response = await connection.request(method, JSON.parse(rawParams), 20_000)
  process.stdout.write(`${JSON.stringify(response)}\n`)
  if (!response.ok) {
    process.exitCode = 1
  }
} finally {
  connection.close()
}

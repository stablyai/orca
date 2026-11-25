import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  launchBrowserNetworkRelay,
  type BrowserNetworkRelayChild
} from './browser-network-relay-launch'

let relayPath: string
let previousRelayPath: string | undefined

beforeEach(() => {
  relayPath = mkdtempSync(join(tmpdir(), 'orca-relay-launch-'))
  const wsl = join(relayPath, 'wsl')
  mkdirSync(wsl)
  writeFileSync(join(wsl, 'wsl-browser-network-relay.js'), '')
  writeFileSync(join(wsl, '.browser-network-version'), '1.0.0+abc')
  previousRelayPath = process.env.ORCA_RELAY_PATH
  process.env.ORCA_RELAY_PATH = relayPath
})

afterEach(() => {
  if (previousRelayPath === undefined) {
    delete process.env.ORCA_RELAY_PATH
  } else {
    process.env.ORCA_RELAY_PATH = previousRelayPath
  }
  rmSync(relayPath, { recursive: true, force: true })
})

function fakeChild(): BrowserNetworkRelayChild & { stdout: PassThrough } {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => {}
  })
}

// A login profile on an SSH host can print to stdout before the relay runs.
it('hands the tunnel exactly the bytes after the readiness sentinel', async () => {
  const child = fakeChild()
  const launching = launchBrowserNetworkRelay(
    { homeDir: '.orca-remote/browser-network', run: async () => child },
    new AbortController().signal
  )
  await new Promise((resolve) => setImmediate(resolve))
  child.stdout.write('Welcome to the sandbox\nORCA-BROWSER-NET')
  child.stdout.write(Buffer.concat([Buffer.from('WORK-RELAY v2 READY\n'), Buffer.from([0, 1, 2])]))
  const relay = await launching
  const first = new Promise<Buffer>((resolve) => relay.stdout.once('data', resolve))
  relay.stdout.resume()
  expect([...(await first)]).toEqual([0, 1, 2])
})

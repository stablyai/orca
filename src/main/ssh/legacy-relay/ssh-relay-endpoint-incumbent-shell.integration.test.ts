/**
 * The probe script runs on someone else's machine and decides whether a relay holds work,
 * so the shell itself is the part worth testing for real. These cases run the
 * generated scripts through /bin/sh against real unix sockets and real processes.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  isReapableRelayHusk,
  parseRelayEndpointIncumbentProbe,
  relayEndpointIncumbentProbeCommand,
  type RelayEndpointIncumbent
} from './ssh-relay-endpoint-incumbent'
import { RELAY_DAEMON_SERVICE_ENTRY_FILENAMES } from '../relay-install-artifacts'

const posixOnly = process.platform === 'win32' ? describe.skip : describe

const FAKE_RELAY_SOURCE = `
const net = require('net')
const path = require('path')
const sock = process.argv[process.argv.indexOf('--sock-path') + 1]
function spawnChild(args) {
  require('child_process').spawn(process.execPath, args, { stdio: 'ignore' })
}
if (process.argv.includes('--with-child')) {
  spawnChild(['-e', 'setTimeout(() => {}, 60000)'])
}
// Why forked the same way production does: the exclusion is argv-shaped, so a hand-written
// stand-in would test the test rather than the shell that runs on someone's host.
for (const name of process.argv.filter((arg) => arg.startsWith('--service-child='))) {
  spawnChild([path.join(__dirname, name.slice('--service-child='.length))])
}
net.createServer(() => {}).listen(sock, () => process.stdout.write('READY\\n'))
process.on('SIGTERM', () => process.exit(0))
`

// Self-limiting: these outlive a SIGKILLed relay under test.
const IDLE_SERVICE_SOURCE = 'setTimeout(() => {}, 60000)\n'

function sh(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/bin/sh', ['-c', script], { timeout: 20_000 }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolve(stdout)
    })
  })
}

let workDir: string
let hasLsof = false
const running: ChildProcess[] = []

function startFakeRelay(
  sockPath: string,
  options: { withChild?: boolean; serviceChildren?: readonly string[] } = {}
): Promise<ChildProcess> {
  const args = [join(workDir, 'relay.js'), '--sock-path', sockPath]
  if (options.withChild) {
    args.push('--with-child')
  }
  for (const name of options.serviceChildren ?? []) {
    args.push(`--service-child=${name}`)
  }
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'ignore'] })
  running.push(child)
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('READY')) {
        resolve(child)
      }
    })
    child.on('exit', () => reject(new Error('fake relay exited before listening')))
  })
}

async function probe(sockPath: string): Promise<RelayEndpointIncumbent> {
  const output = await sh(relayEndpointIncumbentProbeCommand(process.execPath, sockPath))
  return parseRelayEndpointIncumbentProbe(sockPath, output)
}

/** The relay forks its children after it starts listening, so the probe can race them. */
async function waitForChildCount(
  sockPath: string,
  expected: number
): Promise<RelayEndpointIncumbent> {
  let incumbent = await probe(sockPath)
  for (let attempt = 0; attempt < 50 && incumbent.holders[0]?.childCount !== expected; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    incumbent = await probe(sockPath)
  }
  return incumbent
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'orca-relay-incumbent-'))
  writeFileSync(join(workDir, 'relay.js'), FAKE_RELAY_SOURCE)
  for (const filename of RELAY_DAEMON_SERVICE_ENTRY_FILENAMES) {
    writeFileSync(join(workDir, filename), IDLE_SERVICE_SOURCE)
  }
  writeFileSync(join(workDir, 'looks-like-relay-watcher.js'), IDLE_SERVICE_SOURCE)
  hasLsof = await sh('command -v lsof >/dev/null 2>&1 && echo yes || echo no').then(
    (out) => out.trim() === 'yes'
  )
})

afterEach(() => {
  while (running.length > 0) {
    running.pop()?.kill('SIGKILL')
  }
})

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

it('runs the holder-enumeration assertions on this machine', () => {
  // Why asserted rather than assumed: the cases below degrade to verdict-only checks without
  // lsof, and a silently degraded suite would stop covering the reap gate entirely.
  expect(hasLsof).toBe(true)
})

posixOnly('relay endpoint probe against a real socket', () => {
  it('reports live, and identifies the holding process, for a listening relay', async () => {
    const sockPath = join(workDir, 'live.sock')
    const relay = await startFakeRelay(sockPath)
    const incumbent = await probe(sockPath)

    expect(incumbent.verdict).toBe('live')
    expect(incumbent.evidence).toBe('accepted-connection')
    expect(incumbent.socketPresent).toBe(true)
    if (!hasLsof) {
      return
    }
    expect(incumbent.holders.map((holder) => holder.pid)).toEqual([relay.pid])
    expect(incumbent.holders[0]).toMatchObject({
      matchesRelayArgv: true,
      childCount: 0,
      unrecognizedChildCount: 0
    })
    expect(isReapableRelayHusk(incumbent)).toBe(true)
  })

  it("counts the daemon's own service children but does not hold them against it", async () => {
    const sockPath = join(workDir, 'services.sock')
    await startFakeRelay(sockPath, { serviceChildren: RELAY_DAEMON_SERVICE_ENTRY_FILENAMES })
    const incumbent = await waitForChildCount(sockPath, RELAY_DAEMON_SERVICE_ENTRY_FILENAMES.length)

    expect(incumbent.holders[0].childCount).toBe(RELAY_DAEMON_SERVICE_ENTRY_FILENAMES.length)
    expect(incumbent.holders[0].unrecognizedChildCount).toBe(0)
    expect(isReapableRelayHusk(incumbent)).toBe(true)
  })

  it('still retains a relay holding work alongside its service children', async () => {
    const sockPath = join(workDir, 'services-and-work.sock')
    await startFakeRelay(sockPath, {
      withChild: true,
      serviceChildren: RELAY_DAEMON_SERVICE_ENTRY_FILENAMES
    })
    const incumbent = await waitForChildCount(
      sockPath,
      RELAY_DAEMON_SERVICE_ENTRY_FILENAMES.length + 1
    )

    expect(incumbent.holders[0].unrecognizedChildCount).toBe(1)
    expect(isReapableRelayHusk(incumbent)).toBe(false)
  })

  it('does not excuse a child that merely mentions a service entry name', async () => {
    const sockPath = join(workDir, 'lookalike.sock')
    await startFakeRelay(sockPath, { serviceChildren: ['looks-like-relay-watcher.js'] })
    const incumbent = await waitForChildCount(sockPath, 1)

    expect(incumbent.holders[0].unrecognizedChildCount).toBe(1)
    expect(isReapableRelayHusk(incumbent)).toBe(false)
  })

  it('refuses to call a relay with a live child an empty husk', async () => {
    const sockPath = join(workDir, 'busy.sock')
    await startFakeRelay(sockPath, { withChild: true })
    const incumbent = hasLsof ? await waitForChildCount(sockPath, 1) : await probe(sockPath)

    expect(incumbent.verdict).toBe('live')
    if (!hasLsof) {
      return
    }
    expect(incumbent.holders[0].childCount).toBeGreaterThan(0)
    expect(isReapableRelayHusk(incumbent)).toBe(false)
  })

  it('reports exited for a socket inode a SIGKILLed relay left behind', async () => {
    const sockPath = join(workDir, 'stale.sock')
    const relay = await startFakeRelay(sockPath)
    relay.kill('SIGKILL')
    await new Promise((resolve) => relay.on('exit', resolve))

    const incumbent = await probe(sockPath)
    expect(incumbent.socketPresent).toBe(true)
    expect(incumbent.verdict).toBe(hasLsof ? 'exited' : 'unverifiable')
  })

  it('answers unverifiable when lsof cannot stat a never-bound path', async () => {
    const incumbent = await probe(join(workDir, 'never-existed.sock'))
    expect(incumbent.socketPresent).toBe(false)
    expect(incumbent.verdict).toBe('unverifiable')
    expect(incumbent.holdersEnumerable).toBe(false)
    expect(incumbent.holders).toEqual([])
    expect(isReapableRelayHusk(incumbent)).toBe(false)
  })
})

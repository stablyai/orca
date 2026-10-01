import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn(),
  isUnconfirmedSshCommandTermination: () => false
}))
import {
  relayEndpointIncumbentProbeCommand,
  parseRelayEndpointIncumbentProbe,
  mayLaunchOverRelayEndpoint,
  isReapableRelayHusk
} from './ssh-relay-endpoint-incumbent'

async function probe(script: string, listening = false) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-incumbent-'))
  const socket = join(dir, 'socket with spaces.sock')
  const server = createServer((s) => s.end())
  const pidFile = join(dir, 'probe.pid')
  try {
    writeFileSync(join(dir, 'lsof'), `#!/bin/sh\n${script}`, { mode: 0o755 })
    if (listening) {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socket, resolve)
      })
    }
    const start = performance.now()
    const result = await runProcess({
      program: '/bin/sh',
      args: ['-c', relayEndpointIncumbentProbeCommand(process.execPath, socket)],
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FIXTURE_PID: pidFile },
      timeoutMs: 12000,
      detached: true,
      terminationBarrier: true
    })
    const verdict = parseRelayEndpointIncumbentProbe(socket, result.stdout)
    let pidAlive: boolean | null = null
    try {
      const pid = Number(readFileSync(pidFile, 'utf8'))
      const state = await runProcess({
        program: 'ps',
        args: ['-o', 'state=', '-p', String(pid)],
        timeoutMs: 2000
      })
      pidAlive = !(
        (state.code === 1 && !state.stdout.trim()) ||
        (state.code === 0 && state.stdout.trim().startsWith('Z'))
      )
    } catch {}
    return { result, verdict, elapsedMs: performance.now() - start, pidAlive }
  } finally {
    if (listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    try {
      const pid = Number(readFileSync(pidFile, 'utf8'))
      if (Number.isInteger(pid) && pid > 0) {
        process.kill(pid, 'SIGKILL')
      }
    } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
}
describe.skipIf(process.platform === 'win32')('real generated incumbent probe', () => {
  it('bounds hung lsof and preserves live connect evidence', async () => {
    const p = await probe('echo $$ > "$FIXTURE_PID"\nexec sleep 60\n', true)
    expect(p.result.timedOut).toBe(false)
    expect(p.result.code).toBe(0)
    expect(p.verdict).toMatchObject({
      verdict: 'live',
      holdersEnumerable: false,
      evidence: 'accepted-connection'
    })
    expect(p.pidAlive).toBe(false)
    expect(p.elapsedMs).toBeLessThan(10000)
  })
  it('stops a hung lsof helper as well as its parent', async () => {
    const p = await probe('sleep 60 &\necho $! > "$FIXTURE_PID"\nwait\n', true)
    expect(p.result.timedOut).toBe(false)
    expect(p.verdict).toMatchObject({ verdict: 'live', holdersEnumerable: false })
    expect(p.pidAlive).toBe(false)
    expect(p.elapsedMs).toBeLessThan(10000)
  })
  it('does not mistake diagnostic enumeration failure for proven absence', async () => {
    const p = await probe('echo "lsof: access denied" >&2\nexit 1\n')
    expect(p.verdict).toMatchObject({ verdict: 'unverifiable', holdersEnumerable: false })
  })
  it.each(['echo "lsof: partial results" >&2\nexit 0\n', 'exit 2\n', 'exec sleep 60\n'])(
    'preserves positive holders from incomplete enumeration: %s',
    async (ending) => {
      const p = await probe(`echo ${process.pid}\n${ending}`)
      expect(p.verdict).toMatchObject({
        verdict: 'live',
        evidence: 'holder-process',
        holdersEnumerable: false
      })
      expect(p.verdict.holders.map((holder) => holder.pid)).toContain(process.pid)
      expect(mayLaunchOverRelayEndpoint(p.verdict)).toBe(false)
      expect(isReapableRelayHusk(p.verdict)).toBe(false)
    }
  )
  it.each(['printf 123', 'echo malformed'])(
    'rejects incomplete or malformed PID records: %s',
    async (script) => {
      const p = await probe(script)
      expect(p.verdict).toMatchObject({
        verdict: 'unverifiable',
        holdersEnumerable: false,
        holders: []
      })
    }
  )
  it('preserves a completed empty enumeration', async () => {
    const p = await probe('exit 1\n')
    expect(p.verdict).toMatchObject({ verdict: 'exited', holdersEnumerable: true })
  })
})

import type * as ExecCommandModule from '../../remote-exec/remote-exec-command'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
vi.mock('../../remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: vi.fn()
}))
import {
  relayEndpointIncumbentProbeCommand,
  parseRelayEndpointIncumbentProbe,
  isReapableRelayHusk
} from './ssh-relay-endpoint-incumbent'

async function probe(script: string, listening = false) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-incumbent-'))
  const socket = join(dir, 'socket with spaces.sock')
  const server = createServer((s) => s.end())

  try {
    writeFileSync(join(dir, 'lsof'), `#!/bin/sh\n${script}`, { mode: 0o755 })
    if (listening) {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socket, resolve)
      })
    }

    const result = await runProcess({
      program: '/bin/sh',
      args: ['-c', relayEndpointIncumbentProbeCommand(process.execPath, socket)],
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      timeoutMs: 12000,
      detached: true,
      terminationBarrier: true
    })
    const verdict = parseRelayEndpointIncumbentProbe(socket, result.stdout)

    return { result, verdict }
  } finally {
    if (listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }

    rmSync(dir, { recursive: true, force: true })
  }
}
// Each probe owns its socket, shim and process group; overlap the real lsof deadlines.
describe.skipIf(process.platform === 'win32').concurrent('real generated incumbent probe', () => {
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

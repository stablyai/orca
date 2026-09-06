// Bug 2b (wave 7): one-shot live probe settling whether OMP's TUI-rendered
// "recap" (the italic `※ recap: ...` status line) ever crosses the RPC wire.
// Opt-in and skipped unless ORCA_OMP_RPC_LIVE=1 and an omp binary resolves —
// same gate as omp-rpc-live.test.ts. Sends ONE trivial prompt over a
// session-owning client with the advisor extension active (the default for a
// normal cwd-scoped session — no special flag needed) and dumps every frame
// received, verbatim, to a temp file for grep. This is a control-plane +
// single-turn probe: one prompt, no retries, budget-cheap.

import { describe, expect, it } from 'vitest'
import { access, constants as fsConstants, mkdtemp, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnOmpRpcClient } from './omp-rpc-client'
import type { OmpRpcClientEvent } from '../../shared/omp-rpc-protocol'

const LIVE_ENABLED = process.env.ORCA_OMP_RPC_LIVE === '1'

async function findOmp(): Promise<string | null> {
  const fromEnv = process.env.ORCA_OMP_RPC_LIVE_BIN
  const candidates = [
    ...(fromEnv ? [fromEnv] : []),
    path.join(os.homedir(), '.local', 'bin', 'omp'),
    path.join(os.homedir(), '.bun', 'bin', 'omp'),
    '/opt/homebrew/bin/omp',
    '/usr/local/bin/omp'
  ]
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  return null
}

describe.skipIf(!LIVE_ENABLED)('omp rpc recap probe (Bug 2b)', () => {
  it('dumps every frame from one live turn so the recap can be settled by grep, not guesswork', async () => {
    const executablePath = await findOmp()
    if (!executablePath) {
      throw new Error('ORCA_OMP_RPC_LIVE=1 but no omp binary found')
    }
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'omp-rpc-recap-probe-'))
    const client = spawnOmpRpcClient({ executablePath, cwd, sessionMode: 'session-owning' })
    const rawEvents: OmpRpcClientEvent[] = []
    const { promise: turnEnded, resolve: resolveTurnEnded } = Promise.withResolvers<void>()
    client.on((event) => {
      rawEvents.push(event)
      if (event.kind === 'agent-end' || event.kind === 'exit' || event.kind === 'protocol-fault') {
        resolveTurnEnded()
      }
    })
    try {
      await client.whenReady()
      await client.prompt('whats 2+2')
      // Why (real wall-clock wait, deliberately): this is a live integration
      // probe against a real `omp` subprocess, not a unit test — there is no
      // fake-timer-controllable clock to advance. `prompt()` resolves once
      // the wire acks the message, not once the turn's frames finish
      // streaming (omp-rpc-client-turn-events.test.ts's scripted fixtures
      // happen to interleave synchronously; a real omp process does not), so
      // the primary wait is the `agent-end` event itself; this bound only
      // stops the probe from hanging forever if a real process wedges,
      // matching the test's own 60s outer timeout.
      await Promise.race([turnEnded, new Promise<void>((resolve) => setTimeout(resolve, 20_000))])
    } finally {
      client.dispose()
    }

    const dumpPath = path.join(cwd, 'raw-frames.jsonl')
    const serialized = rawEvents.map((event) => JSON.stringify(event)).join('\n')
    await writeFile(dumpPath, serialized)
    // Why: the verdict is the point of this probe; print the dump path so a
    // human/CI log can inspect it.
    console.log(`[Bug 2b probe] raw frame dump: ${dumpPath}`)

    const recapCandidates = rawEvents.filter(
      (event) => JSON.stringify(event).includes('recap') || JSON.stringify(event).includes('\u203B')
    )
    // Why: same as above — this is the probe's actual verdict, not
    // incidental debug noise.
    console.log(
      `[Bug 2b probe] recap/\u203B candidates: ${recapCandidates.length ? JSON.stringify(recapCandidates) : 'NONE — recap never crosses the RPC wire in this run'}`
    )

    // This assertion is the probe's contract, not a guess: at minimum a
    // completed turn must produce an agent-end frame, proving the dump
    // actually captured a real turn (and not, say, a spawn failure).
    expect(rawEvents.some((event) => event.kind === 'agent-end')).toBe(true)
    expect(serialized.length).toBeGreaterThan(0)
  }, 60_000)
})

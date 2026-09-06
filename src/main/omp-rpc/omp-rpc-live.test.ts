// Opt-in live probe against a real installed OMP. Skipped unless
// ORCA_OMP_RPC_LIVE=1 and an omp binary resolves, so CI (which has neither)
// stays green while a developer can prove the client against the real agent.

import { describe, expect, it } from 'vitest'
import { access, constants as fsConstants, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnOmpRpcClient } from './omp-rpc-client'

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

describe.skipIf(!LIVE_ENABLED)('omp rpc client against a live OMP', () => {
  it('negotiates v2, lists the command catalog, and runs /usage locally', async () => {
    const executablePath = await findOmp()
    if (!executablePath) {
      // Why: enabling the flag on a machine without omp is a setup mistake, not
      // a product failure — fail loudly rather than passing vacuously.
      throw new Error('ORCA_OMP_RPC_LIVE=1 but no omp binary found')
    }
    const client = spawnOmpRpcClient({ executablePath, cwd: process.cwd(), noSession: true })
    const outputs: string[] = []
    client.on((event) => {
      if (event.kind === 'command-output') {
        outputs.push(event.text)
      }
    })
    try {
      const ready = await client.whenReady()
      expect(ready.negotiatedProtocolVersion).toBe(2)
      expect(ready.ready.supportedProtocolVersions).toContain(2)

      const commands = await client.getCommands()
      expect(commands.length).toBeGreaterThan(50)
      expect(commands.map((command) => command.name)).toContain('usage')

      // /usage is a local command: it must report agentInvoked=false and emit
      // its full output before the prompt settles.
      const result = await client.prompt('/usage')
      expect(result.agentInvoked).toBe(false)
      expect(outputs.length).toBeGreaterThan(0)
      expect(outputs.join('')).toContain('Usage')
    } finally {
      client.dispose()
    }
  }, 60_000)
})

describe.skipIf(!LIVE_ENABLED)('omp rpc switch_session sessionPath vs bare id (F12)', () => {
  it('requires the absolute session file path — a bare session id silently fails to switch', async () => {
    const executablePath = await findOmp()
    if (!executablePath) {
      throw new Error('ORCA_OMP_RPC_LIVE=1 but no omp binary found')
    }
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'omp-rpc-f12-'))
    // Create a real session: session-owning mode creates/loads a session for
    // `cwd` on spawn, before any prompt — get_state is a control-plane call,
    // no model invocation needed.
    const origin = spawnOmpRpcClient({ executablePath, cwd, sessionMode: 'session-owning' })
    let sessionId: string
    let sessionFile: string
    try {
      await origin.whenReady()
      const state = await origin.getState()
      if (!state.sessionFile || !state.sessionId) {
        throw new Error('origin session did not report a complete session identity')
      }
      sessionFile = state.sessionFile
      sessionId = state.sessionId
    } finally {
      origin.dispose()
    }

    const probe = async (
      sessionPath: string
    ): Promise<{ ok: true } | { ok: false; error: string }> => {
      const client = spawnOmpRpcClient({ executablePath, cwd, sessionMode: 'session-owning' })
      try {
        await client.whenReady()
        await client.switchSession(sessionPath)
        const state = await client.getState()
        return state.sessionFile === sessionFile
          ? { ok: true }
          : { ok: false, error: 'sessionFile mismatch after switch' }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      } finally {
        client.dispose()
      }
    }

    const bareIdResult = await probe(sessionId)
    const absolutePathResult = await probe(sessionFile)

    // Why: F12 live verdict against omp 18.0.6, recorded in
    // docs/omp-rpc-chat-adapter-plan.md — `switch_session` does NOT throw on
    // a bare id, but silently fails to switch (get_state's sessionFile never
    // matches); only the absolute session file path actually switches.
    expect(bareIdResult).toEqual({ ok: false, error: 'sessionFile mismatch after switch' })
    expect(absolutePathResult).toEqual({ ok: true })
  }, 60_000)
})

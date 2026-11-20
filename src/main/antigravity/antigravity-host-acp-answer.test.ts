import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AcpAgentError } from '../acp/transport/acp-errors'

const listing = vi.hoisted((): { error: unknown } => ({ error: null }))
vi.mock('./antigravity-acp-runtime-probe', () => ({
  initializeAntigravityAcp: async (
    _launch: unknown,
    _timeoutMs: number,
    _signal: unknown,
    check: (connection: unknown, initialized: unknown, folder: string) => Promise<void>
  ) => {
    // agy 1.5.13's own initialize answer, trimmed to what the check reads.
    const initialized = {
      protocolVersion: 1,
      agentInfo: { name: 'Antigravity ACP Server', version: '1.5.13' },
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {}, list: {} },
        _meta: { antigravity: { systemPrompt: { append: true } } }
      }
    }
    const listSessions = async () => {
      throw listing.error
    }
    await check({ listSessions }, initialized, tmpdir())
    return initialized
  }
}))

const { checkAntigravityHostAcp, forgetAntigravityHostAcpChecks } =
  await import('./antigravity-host-acp')

const folders: string[] = []
afterEach(() => {
  folders.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
  forgetAntigravityHostAcpChecks()
})

function agyBinary(): string {
  const folder = mkdtempSync(join(tmpdir(), 'agy-bin-'))
  folders.push(folder)
  writeFileSync(join(folder, 'agy'), 'agy')
  return join(folder, 'agy')
}

it.each([
  ['asks to sign in', new AcpAgentError(-32000, 'Authentication required'), 'signedOut'],
  ['times out listing sessions', new Error('session/list timed out'), 'unanswered'],
  ['fails listing sessions', new AcpAgentError(-32603, 'Internal error'), 'unanswered']
])('a compatible agy that %s answers %s', async (_case, error, expected) => {
  listing.error = error

  expect(await checkAntigravityHostAcp(agyBinary(), {}, [])).toBe(expected)
})

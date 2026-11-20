import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as HostAcp from './antigravity-host-acp'

vi.mock('./antigravity-host-acp', async (importOriginal) => ({
  ...(await importOriginal<typeof HostAcp>()),
  hasAgyCredential: async () => true,
  antigravityHostAcpReady: async () => true
}))

const { ANTIGRAVITY_LAUNCH_SPEC } = await import('./antigravity-acp-launch-spec')
const { answerAntigravityChatAuth } = await import('./antigravity-chat-account')

const folders: string[] = []
afterEach(() => folders.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })))

describe('Antigravity host backend selection', () => {
  it("runs new chats on a signed-in agy even when Orca's own Chat is signed in", async () => {
    const homePath = mkdtempSync(join(tmpdir(), 'agy-home-'))
    const stateDirectory = mkdtempSync(join(tmpdir(), 'orca-data-'))
    folders.push(homePath, stateDirectory)
    const managed = join(stateDirectory, 'antigravity-chat', 'antigravity-acp')
    mkdirSync(managed, { recursive: true })
    writeFileSync(join(managed, 'acp_token.json'), '{}')
    answerAntigravityChatAuth(true)

    const home = await ANTIGRAVITY_LAUNCH_SPEC.hostBackend.select({
      command: '/usr/local/bin/agy',
      env: {},
      envToDelete: [],
      homePath,
      stateDirectory,
      settings: {}
    })

    expect(home).toEqual({ variable: 'GEMINI_HOME', path: join(homePath, '.gemini') })
  })
})

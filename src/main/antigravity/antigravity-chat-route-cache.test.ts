import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type * as HostAcp from './antigravity-host-acp'

const presence = vi.hoisted(() => vi.fn(async () => 'absent' as const))
const compatibility = vi.hoisted(() => vi.fn(async () => 'ready' as const))
const fullCheck = vi.hoisted(() => vi.fn(async () => 'ready' as const))
vi.mock('./agy-credential-presence', () => ({ agyCredentialPresence: presence }))
vi.mock('./antigravity-host-acp', async (importOriginal) => ({
  ...(await importOriginal<typeof HostAcp>()),
  checkAntigravityHostAcp: fullCheck,
  checkAntigravityHostAcpCompatible: compatibility
}))

const { lastAntigravityAgySignedOut } = await import('./antigravity-chat-route')
const { antigravityHostChatRoute } = await import('./antigravity-acp-launch-spec')

const folders: string[] = []
afterEach(() => folders.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })))

it('says agy is signed out only from an answer already found, never by asking itself', async () => {
  expect(lastAntigravityAgySignedOut()).toBeNull()
  expect(presence).not.toHaveBeenCalled()
  expect(compatibility).not.toHaveBeenCalled()
  expect(fullCheck).not.toHaveBeenCalled()

  const homePath = mkdtempSync(join(tmpdir(), 'agy-home-'))
  const stateDirectory = mkdtempSync(join(tmpdir(), 'orca-data-'))
  folders.push(homePath, stateDirectory)
  const command = join(homePath, 'agy')
  writeFileSync(command, '')
  // A chat start on a host whose agy has no login.
  await antigravityHostChatRoute({
    command,
    env: { PATH: '' },
    envToDelete: [],
    homePath,
    stateDirectory,
    settings: {},
    startsProgram: true
  })

  expect(lastAntigravityAgySignedOut()).toBe(true)
})

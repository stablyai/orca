import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type * as HostAcp from './antigravity-host-acp'

// agy is installed and signed in, which would otherwise take every Google-account chat.
vi.mock('./agy-credential-presence', () => ({ agyCredentialPresence: async () => 'present' }))
vi.mock('./antigravity-host-acp', async (importOriginal) => ({
  ...(await importOriginal<typeof HostAcp>()),
  agyUsesApiKey: async () => false,
  checkAntigravityHostAcp: async () => 'ready',
  checkAntigravityHostAcpCompatible: async () => 'ready'
}))

const { antigravityHostChatRoute } = await import('./antigravity-acp-launch-spec')

const folders: string[] = []
afterEach(() => folders.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })))

async function route(
  antigravityGoogleSignIn?: 'auto' | 'agy' | 'orca',
  { orcaSignedIn = false }: { orcaSignedIn?: boolean } = {}
) {
  const homePath = mkdtempSync(join(tmpdir(), 'agy-home-'))
  const stateDirectory = mkdtempSync(join(tmpdir(), 'orca-data-'))
  folders.push(homePath, stateDirectory)
  if (orcaSignedIn) {
    // A Google sign-in Orca's server saved, which puts this host's chats on the server.
    mkdirSync(join(stateDirectory, 'antigravity-chat', 'antigravity-acp'), { recursive: true })
    writeFileSync(
      join(stateDirectory, 'antigravity-chat', 'antigravity-acp', 'acp_token.json'),
      '{}'
    )
  }
  const command = join(homePath, 'agy')
  writeFileSync(command, '')
  return antigravityHostChatRoute({
    command,
    env: { PATH: '' },
    envToDelete: [],
    homePath,
    stateDirectory,
    settings: {
      antigravityChatAuth: { method: 'oauth-personal' },
      ...(antigravityGoogleSignIn ? { antigravityGoogleSignIn } : {})
    },
    startsProgram: true
  })
}

it("runs Google-account chats on Orca's server, and installs it, once Orca's sign-in is chosen", async () => {
  expect(await route('orca')).toEqual({ agy: false, installs: 'server' })
})

it('keeps them on agy without that choice', async () => {
  expect(await route()).toEqual({ agy: 'signedIn', installs: 'agy' })
  expect(await route('agy')).toEqual({ agy: 'signedIn', installs: 'agy' })
})

it("keeps a host signed in through Orca's sign-in on the server by default, and moves it to agy only when chosen", async () => {
  expect(await route(undefined, { orcaSignedIn: true })).toMatchObject({ installs: 'server' })
  expect(await route('auto', { orcaSignedIn: true })).toMatchObject({ installs: 'server' })
  expect(await route('agy', { orcaSignedIn: true })).toEqual({ agy: 'signedIn', installs: 'agy' })
})

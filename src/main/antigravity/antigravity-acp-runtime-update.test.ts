import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  resolveInstalledRuntimeRelease,
  writeRuntimeReleaseReceipt,
  type ManagedRuntimePin
} from '../node-runtime/managed-runtime-release'
import { resolveAcpLaunchCommand } from '../acp/launch/acp-launch-command'
import { ANTIGRAVITY_ACP_COMMAND, ANTIGRAVITY_ACP_RUNTIME } from './antigravity-acp-runtime'
import { ANTIGRAVITY_LAUNCH_SPEC } from './antigravity-acp-launch-spec'

let data = ''
afterEach(() => rmSync(data, { recursive: true, force: true }))

const HARNESS = process.platform === 'win32' ? 'localharness_external.exe' : 'localharness_external'

/** An installed server release as Install leaves it: both members and the receipt. */
async function installRelease(version: string, archiveSha256: string): Promise<string> {
  const folder = join(ANTIGRAVITY_ACP_RUNTIME.root(data), version)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, ANTIGRAVITY_ACP_COMMAND), 'server', { mode: 0o755 })
  writeFileSync(join(folder, HARNESS), 'harness', { mode: 0o755 })
  const pin: ManagedRuntimePin = {
    version,
    url: 'https://example.test/server.zip',
    archiveBytes: 1,
    archiveSha256,
    members: [
      { path: ANTIGRAVITY_ACP_COMMAND, sha256: 'a'.repeat(64), bytes: 6 },
      { path: HARNESS, sha256: 'b'.repeat(64), bytes: 7 }
    ]
  }
  await writeRuntimeReleaseReceipt(folder, pin)
  return folder
}

const launch = () =>
  resolveAcpLaunchCommand(
    ANTIGRAVITY_LAUNCH_SPEC,
    { PATH: '' },
    { dataDirectory: data, homePath: data }
  )

it("pins Google's server 1.5.2 on every platform Orca installs it on", () => {
  const pin = ANTIGRAVITY_ACP_RUNTIME.pin()
  if (pin === null) {
    return
  }
  expect(pin.version).toBe('1.5.2')
  expect(pin.url).toMatch(
    /^https:\/\/dl\.google\.com\/agy-extensions\/releases\/(macos|linux|windows)\/agy-acp-server-1\.5\.2-[a-z]+-(arm64|x86_64)\.zip$/
  )
})

it('keeps chats running on an installed 1.5.0 after the pin moves, and offers the update', async () => {
  data = mkdtempSync(join(tmpdir(), 'orca-server-update-'))
  const old = await installRelease('1.5.0', 'c'.repeat(64))
  // Orca's sign-in lives in the chat home, which no release change touches.
  const chatHome = join(data, 'antigravity-chat', 'antigravity-acp')
  mkdirSync(chatHome, { recursive: true })
  writeFileSync(join(chatHome, 'acp_token.json'), '{"signed":"in"}')

  expect(launch()).toMatchObject({ command: join(old, ANTIGRAVITY_ACP_COMMAND), version: '1.5.0' })
  expect(
    resolveInstalledRuntimeRelease(
      ANTIGRAVITY_ACP_RUNTIME.root(data),
      ANTIGRAVITY_ACP_RUNTIME.pin()
    ).release
  ).toMatchObject({
    version: '1.5.0',
    current: false
  })
})

it('launches the updated 1.5.2 once it is installed beside 1.5.0', async () => {
  const pin = ANTIGRAVITY_ACP_RUNTIME.pin()
  if (pin === null || !('archiveSha256' in pin)) {
    return
  }
  data = mkdtempSync(join(tmpdir(), 'orca-server-update-'))
  await installRelease('1.5.0', 'c'.repeat(64))
  const updated = await installRelease('1.5.2', pin.archiveSha256)

  expect(launch()).toMatchObject({
    command: join(updated, ANTIGRAVITY_ACP_COMMAND),
    version: '1.5.2'
  })
})

import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { findQwenWorkDesktopEngine } from './qwenwork-desktop-engine'

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

it('launches the executable with its own ACP entry and ignores incomplete desktop updates', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'qwenwork-install-')))
  folders.push(root)
  const release = join(root, '2.1.0-10')
  const sdk = join(release, 'resources', 'agent-sdk')
  const relative = 'components/flash-cli/1.2/runtime/flash-cli-acp.mjs'
  const entry = join(sdk, relative)
  const command = join(release, 'QwenWorkCN.exe')
  await mkdir(dirname(entry), { recursive: true })
  await mkdir(dirname(command), { recursive: true })
  await mkdir(join(root, '2.1.0-11'))
  await writeFile(command, '')
  await chmod(command, 0o755)
  await writeFile(entry, '')
  await writeFile(
    join(sdk, 'engine-runtime-manifest.json'),
    JSON.stringify({
      engines: { opencode: { runtime: 'electron-node', entrypoint: relative, args: [] } }
    })
  )
  const descriptor = join(sdk, 'components/flash-cli/1.2/engine-manifest.json')
  const env = { ORCA_QWENWORK_INSTALL_DIR: root }
  await writeFile(descriptor, '{"engineId":"opencode","protocol":"http"}')
  expect(await findQwenWorkDesktopEngine(env, 'win32')).toBeNull()
  await writeFile(descriptor, '{"engineId":"opencode","protocol":"acp-stdio"}')
  expect(await findQwenWorkDesktopEngine(env, 'win32')).toEqual({ command, prefixArgs: [entry] })
})

it('uses the Mac desktop bridge only when the desktop control service has an endpoint', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'qwenwork-mac-install-')))
  folders.push(root)
  const installation = join(root, 'QwenWorkCN.app')
  const profile = join(root, 'profile')
  const command = join(installation, 'Contents', 'MacOS', 'QwenWorkCN')
  await mkdir(dirname(command), { recursive: true })
  await writeFile(command, '')
  const env = {
    ORCA_QWENWORK_INSTALL_DIR: installation,
    ORCA_QWENWORK_DESKTOP_PROFILE: profile
  }
  expect(await findQwenWorkDesktopEngine(env, 'darwin')).toBeNull()

  const endpoint = join(profile, 'cli-control', 'endpoint.json')
  await mkdir(dirname(endpoint), { recursive: true })
  await writeFile(endpoint, '{}')
  const program = await findQwenWorkDesktopEngine(env, 'darwin')
  expect(program?.command).toBe(command)
  expect(program?.prefixArgs).toEqual([expect.stringMatching(/desktop-acp\.cjs$/), profile])
})

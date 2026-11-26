import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { findQwenWorkDesktopEngine } from './qwenwork-desktop-engine'

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

it('uses the desktop bridge on Windows and ignores incomplete client updates', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'qwenwork-install-')))
  folders.push(root)
  const release = join(root, '2.1.0-10')
  const command = join(release, 'QwenWorkCN.exe')
  const newerRelease = join(root, '2.1.0-11')
  await mkdir(join(release, 'resources'), { recursive: true })
  await mkdir(newerRelease)
  await writeFile(join(newerRelease, 'QwenWorkCN.exe'), '')
  await writeFile(command, '')
  const env = { ORCA_QWENWORK_INSTALL_DIR: root, APPDATA: join(root, 'roaming') }
  expect(await findQwenWorkDesktopEngine(env, 'win32')).toBeNull()
  await writeFile(join(release, 'resources', 'app.asar'), '')
  expect(await findQwenWorkDesktopEngine(env, 'win32')).toEqual({
    command,
    prefixArgs: [expect.stringMatching(/desktop-acp\.cjs$/), join(env.APPDATA, 'QwenWorkCN')]
  })
})

it('finds the Mac desktop bridge before the local control service starts', async () => {
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
  const program = await findQwenWorkDesktopEngine(env, 'darwin')
  expect(program?.command).toBe(command)
  expect(program?.prefixArgs).toEqual([expect.stringMatching(/desktop-acp\.cjs$/), profile])
})

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  resolveExternalChromiumProfilePath,
  type ExternalChromiumProfileEnvironment
} from './external-chromium-profile-path'

let root: string
let environment: ExternalChromiumProfileEnvironment

async function installSnap(
  name: string,
  manifest: string,
  snapRoot = environment.snapRoots[0]
): Promise<string> {
  const launcher = join(snapRoot, 'bin', name)
  await mkdir(join(snapRoot, 'bin'), { recursive: true })
  await symlink(join(root, 'usr', 'bin', 'snap'), launcher)
  const meta = join(snapRoot, name, 'current', 'meta')
  await mkdir(meta, { recursive: true })
  await writeFile(join(meta, 'snap.yaml'), manifest)
  return launcher
}

function resolve(executablePath: string): Promise<string> {
  return resolveExternalChromiumProfilePath(
    { executablePath, provider: 'chromium' },
    join(root, 'state'),
    '0123456789abcdef',
    environment
  )
}

describe.skipIf(process.platform === 'win32')('external Chromium profile path', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orcad-chromium-profile-'))
    environment = {
      platform: 'linux',
      snapRoots: [join(root, 'snap'), join(root, 'var', 'lib', 'snapd', 'snap')],
      homePath: () => join(root, 'home')
    }
    await mkdir(join(root, 'usr', 'bin'), { recursive: true })
    await writeFile(join(root, 'usr', 'bin', 'snap'), '')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('moves a strictly confined snap profile out of hidden home directories', async () => {
    const launcher = await installSnap('chromium', 'name: chromium\nconfinement: strict\n')
    const alias = join(root, 'chromium')
    await symlink(launcher, alias)

    const expected = join(
      root,
      'home',
      'snap',
      'chromium',
      'common',
      'orca-browser-0123456789abcdef'
    )
    await expect(resolve(launcher)).resolves.toBe(expected)
    await expect(resolve(alias)).resolves.toBe(expected)
  })

  it('treats a snap without declared confinement as strict under either mount root', async () => {
    const launcher = await installSnap('chromium', 'name: chromium\n', environment.snapRoots[1])

    await expect(resolve(launcher)).resolves.toBe(
      join(root, 'home', 'snap', 'chromium', 'common', 'orca-browser-0123456789abcdef')
    )
  })

  it('keeps the state profile for unconfined snaps and ordinary executables', async () => {
    const classic = await installSnap('chromium', 'name: chromium\nconfinement: classic\n')
    const ordinary = join(root, 'opt', 'chromium')
    await mkdir(join(root, 'opt'))
    await writeFile(ordinary, '')
    const stateProfile = join(root, 'state', 'browser-chromium')

    await expect(resolve(classic)).resolves.toBe(stateProfile)
    await expect(resolve(ordinary)).resolves.toBe(stateProfile)
    await expect(resolve(join(root, 'missing', 'chromium'))).resolves.toBe(stateProfile)
  })

  it('keeps a state profile the snap has already run on', async () => {
    const launcher = await installSnap('chromium', 'name: chromium\n')
    const stateProfile = join(root, 'state', 'browser-chromium')
    await mkdir(stateProfile, { recursive: true })
    await writeFile(join(stateProfile, 'Local State'), '{}')

    await expect(resolve(launcher)).resolves.toBe(stateProfile)
  })
})

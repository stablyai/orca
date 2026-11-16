import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import { macCoordinationRoot } from '../../../shared/remote-runtime/serve-supervisor/serve-bundle-coordination'
import {
  commitServeSupervisorParkOnQuit,
  releaseServeSupervisorPark
} from '../../updater/lifecycle/serve-supervisor-install-park'
import { resolveOrcadBrowserProvider, type OrcadBrowserProvider } from './orcad-browser-provider'

vi.mock('@orca/process-host', () => ({
  runProcess: vi.fn(),
  spawnProcess: vi.fn(() => {
    throw new Error('spawned')
  })
}))

const spawnProcessMock = vi.mocked(spawnProcess)

// Windows resolves the home directory from USERPROFILE, so the park could not be redirected there.
describe.skipIf(process.platform === 'win32')('orcad Electron browser helper', () => {
  let root: string
  let executable: string
  let provider: OrcadBrowserProvider | null = null
  const originalHome = process.env.HOME
  const originalPlatform = process.platform

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orcad-browser-provider-'))
    // Install parks exist only for macOS app bundles.
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    // The install park lives under the user's Library; keep it inside this test.
    process.env.HOME = root
    const bundle = join(root, 'Applications', 'Orca.app')
    executable = join(bundle, 'Contents', 'MacOS', 'Orca')
    await mkdir(join(bundle, 'Contents', 'MacOS'), { recursive: true })
    await writeFile(join(bundle, 'Contents', 'Info.plist'), 'v1')
    spawnProcessMock.mockClear()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await provider?.stop()
    provider = null
    await releaseServeSupervisorPark()
    process.env.HOME = originalHome
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    await rm(root, { recursive: true, force: true })
  })

  it('waits for the new bundle when the desktop is installing an update on quit', async () => {
    await commitServeSupervisorParkOnQuit(executable, macCoordinationRoot(root))
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })

    provider = await resolveOrcadBrowserProvider({
      userDataPath: join(root, 'orcad'),
      environment: {},
      resolveInstalledElectronExecutable: async () => executable
    })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(spawnProcessMock).not.toHaveBeenCalled()
    expect(provider?.kind).toBe('electron')

    // ShipIt swapped the bundle: Info.plist changed.
    await writeFile(join(root, 'Applications', 'Orca.app', 'Contents', 'Info.plist'), 'v2-new')
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() =>
      expect(spawnProcessMock).toHaveBeenCalledWith(
        expect.objectContaining({ program: executable })
      )
    )
  })
})

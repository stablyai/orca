import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  spawn: vi.fn(),
  run: vi.fn(),
  addonLoaded: vi.fn()
}))

vi.mock('../../orcad-distribution/prebuilds/stage-source-iroh.mjs', () => ({
  ensureSourceIrohRuntime: mocks.prepare
}))
vi.mock('node:child_process', async (original) => ({
  ...(await original()),
  spawnSync: mocks.spawn
}))
vi.mock('@orca/process-host', () => ({ runProcessSync: mocks.run }))
vi.mock('node:fs', async (original) => {
  const actual = await original()
  return {
    ...actual,
    existsSync: (path) => String(path).replaceAll('\\', '/').endsWith('/electron/dist/electron'),
    readFileSync: (path, ...args) => {
      const normalized = String(path).replaceAll('\\', '/')
      if (normalized.endsWith('/electron/package.json')) {
        return '{"version":"1.0.0"}'
      }
      if (normalized.endsWith('/electron/dist/version')) {
        return '1.0.0'
      }
      if (normalized.endsWith('/electron/path.txt')) {
        return 'electron'
      }
      return actual.readFileSync(path, ...args)
    }
  }
})
vi.mock('node:module', async (original) => {
  const actual = await original()
  return {
    ...actual,
    createRequire: (url) => {
      const require = actual.createRequire(url)
      if (!String(url).endsWith('/ensure-native-runtime.mjs')) {
        return require
      }
      const fake = (name) => {
        if (name === './node-pty-job-ownership.cjs') {
          return { assertNodePtyJobOwnership() {}, nodePtyAddonPath: () => '/fixture/pty.node' }
        }
        if (name === 'node-pty') {
          return {}
        }
        if (name === 'node-pty/lib/utils') {
          return {
            loadNativeModule: () => {
              mocks.addonLoaded()
              return { dir: '/fixture/build/Release' }
            }
          }
        }
        return require(name)
      }
      fake.resolve = (name) =>
        name === 'node-pty/lib/utils' ? '/fixture/lib/utils.js' : require.resolve(name)
      return fake
    }
  }
})

let warning
const exitSignal = new Error('fixture process exited')

beforeEach(() => {
  vi.resetModules()
  mocks.prepare.mockReset().mockResolvedValue(null)
  mocks.spawn.mockReset().mockReturnValue({ status: 0, stdout: '', stderr: '' })
  mocks.run.mockReset()
  mocks.addonLoaded.mockReset()
  warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Isolate argv and platform without loading real addons or starting child processes. */
function command(args) {
  const isolated = Object.create(process)
  Object.defineProperties(isolated, {
    argv: { value: [process.execPath, '/fixture/ensure-native-runtime.mjs', ...args] },
    platform: { value: 'linux' },
    arch: { value: 'x64' },
    env: { value: { ...process.env, ELECTRON_INSTALL_PLATFORM: 'linux' } },
    exit: {
      value: vi.fn(() => {
        throw exitSignal
      })
    }
  })
  vi.stubGlobal('process', isolated)
  return isolated
}

it.each(['node', 'electron'])(
  'prepares source Iroh before the healthy %s addon early return',
  async (runtime) => {
    command([`--runtime=${runtime}`])
    await import('./ensure-native-runtime.mjs')
    expect(mocks.prepare).toHaveBeenCalledOnce()
    expect(mocks.prepare).toHaveBeenCalledWith({
      root: expect.any(String),
      provision: runtime === 'electron'
    })
    expect(mocks.spawn).toHaveBeenCalledOnce()
    expect(mocks.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.spawn.mock.invocationCallOrder[0]
    )
    expect(mocks.run).not.toHaveBeenCalled()
  }
)

it.each(['node', 'electron'])(
  'keeps unavailable Iroh supplementary for the %s runtime without generic rebuilds',
  async (runtime) => {
    command([`--runtime=${runtime}`])
    mocks.prepare.mockRejectedValue(
      new Error('Patched source Iroh unavailable; run stage-source-iroh.mjs outside FHS')
    )
    await import('./ensure-native-runtime.mjs')
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('outside FHS'))
    expect(mocks.spawn).toHaveBeenCalledOnce()
    expect(mocks.run).not.toHaveBeenCalled()
  }
)

it('--check-only passes a readonly, nonproducing source check and never stages or rebuilds', async () => {
  const isolated = command(['--check-only'])
  mocks.prepare.mockRejectedValue(new Error('Patched source Iroh unavailable'))
  await expect(import('./ensure-native-runtime.mjs')).rejects.toBe(exitSignal)
  expect(mocks.prepare).toHaveBeenCalledWith({
    root: expect.any(String),
    checkOnly: true,
    provision: false
  })
  expect(mocks.addonLoaded).toHaveBeenCalledOnce()
  expect(isolated.exit).toHaveBeenCalledWith(0)
  expect(mocks.spawn).not.toHaveBeenCalled()
  expect(mocks.run).not.toHaveBeenCalled()
})

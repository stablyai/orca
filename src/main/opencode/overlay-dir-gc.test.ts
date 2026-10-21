import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../shared/app-environment'
import { OpenCodeHookService } from './hook-service'
import { OPENCODE_OVERLAY_MANIFEST_FILE } from './opencode-overlay-manifest'
import { OPENCODE_DIR_GC_MIN_AGE_MS, sweepOrphanedOpenCodeDirs } from './overlay-dir-gc'
import { ORCA_OPENCODE_PLUGIN_FILE, sourceOverlayDirName } from './overlay-dir-names'

let root: string
let overlays: string
const now = Date.now()

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-overlay-gc-')))
  overlays = join(root, 'opencode-config-overlays')
  mkdirSync(overlays)
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'xdg'))
  for (const key of [
    'OPENCODE_CONFIG_DIR',
    'ORCA_OPENCODE_CONFIG_DIR',
    'ORCA_OPENCODE_SOURCE_CONFIG_DIR'
  ]) {
    vi.stubEnv(key, '')
  }
  setAppEnvironment({
    getPath: () => root,
    getAppPath: () => root,
    getVersion: () => 'test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

function age(directory: string): void {
  const old = new Date(now - OPENCODE_DIR_GC_MIN_AGE_MS * 2)
  for (const suffix of [
    '',
    OPENCODE_OVERLAY_MANIFEST_FILE,
    'plugins',
    join('plugins', ORCA_OPENCODE_PLUGIN_FILE)
  ]) {
    utimesSync(join(directory, suffix), old, old)
  }
}

function createOverlay(name: string): { source: string; directory: string } {
  const source = join(root, name)
  const directory = join(overlays, sourceOverlayDirName(source))
  mkdirSync(join(directory, 'plugins'), { recursive: true })
  writeFileSync(join(directory, 'plugins', ORCA_OPENCODE_PLUGIN_FILE), 'export default {}')
  writeFileSync(
    join(directory, OPENCODE_OVERLAY_MANIFEST_FILE),
    JSON.stringify({
      topLevelEntries: [],
      pluginEntries: [],
      sourceConfigDir: source
    })
  )
  age(directory)
  return { source, directory }
}

function sweep(extra: Partial<Parameters<typeof sweepOrphanedOpenCodeDirs>[0]> = {}) {
  return sweepOrphanedOpenCodeDirs({
    overlayRoot: overlays,
    pluginFileName: ORCA_OPENCODE_PLUGIN_FILE,
    referencedConfigDirs: new Set(),
    readLivePtyIds: async () => [],
    now,
    yieldBetweenRemovals: async () => {},
    ...extra
  })
}

it('collects only an old, owned missing source while retaining active and reusable sources', async () => {
  const retired = createOverlay('retired')
  const active = createOverlay('active')
  const reusable = createOverlay('reusable')
  mkdirSync(active.source)
  mkdirSync(reusable.source)
  const result = await sweep()
  expect(result.removed).toBe(1)
  expect(result.keptSourcePresent).toBe(2)
  expect(existsSync(retired.directory)).toBe(false)
  expect(existsSync(active.directory)).toBe(true)
  expect(existsSync(reusable.directory)).toBe(true)
})

it.each([null, ['surviving-daemon-pty']] as const)(
  'keeps a retired source with an empty fresh-process reference cache when inventory is %s',
  async (ids) => {
    const retired = createOverlay('retired')
    expect((await sweep({ readLivePtyIds: async () => ids })).removed).toBe(0)
    expect(existsSync(retired.directory)).toBe(true)
  }
)

it('preserves a candidate when owning-host inventory fails', async () => {
  const retired = createOverlay('retired')
  expect(
    (
      await sweep({
        readLivePtyIds: async () => {
          throw new Error('host unavailable')
        }
      })
    ).keptUnverifiable
  ).toBe(1)
  expect(existsSync(retired.directory)).toBe(true)
})

it.each(['service.json', 'service-local.json'])(
  'preserves %s without guessing service process death',
  async (file) => {
    const retired = createOverlay('retired')
    writeFileSync(join(retired.directory, file), '{}')
    age(retired.directory)
    const inventory = vi.fn(async () => [])
    expect((await sweep({ readLivePtyIds: inventory })).keptUnverifiable).toBe(1)
    expect(inventory).not.toHaveBeenCalled()
    expect(existsSync(retired.directory)).toBe(true)
  }
)

it('keeps a young candidate and refreshes reference protection after an asynchronous inventory', async () => {
  const young = createOverlay('young')
  utimesSync(
    join(young.directory, 'plugins', ORCA_OPENCODE_PLUGIN_FILE),
    new Date(now),
    new Date(now)
  )
  const retired = createOverlay('retired')
  const references = new Set<string>()
  const result = await sweep({
    referencedConfigDirs: references,
    readLivePtyIds: async () => {
      references.add(join(retired.directory, 'plugins'))
      return []
    }
  })
  expect(result.keptYoung).toBe(1)
  expect(result.keptReferenced).toBe(1)
  expect(existsSync(retired.directory)).toBe(true)
})

it('does not follow a replaced overlay root or a source ancestor link', async () => {
  const retired = createOverlay('retired')
  const target = join(root, 'elsewhere')
  mkdirSync(target)
  symlinkSync(target, retired.source, process.platform === 'win32' ? 'junction' : 'dir')
  expect((await sweep()).removed).toBe(0)
  rmSync(overlays, { recursive: true })
  symlinkSync(target, overlays, process.platform === 'win32' ? 'junction' : 'dir')
  expect((await sweep()).scanned).toBe(0)
  expect(existsSync(target)).toBe(true)
})

it('retains unowned names, ambiguous old manifests and mismatched source hashes', async () => {
  for (const name of ['shared', '123', 'human']) {
    mkdirSync(join(overlays, name))
  }
  const ambiguous = createOverlay('ambiguous')
  writeFileSync(
    join(ambiguous.directory, OPENCODE_OVERLAY_MANIFEST_FILE),
    JSON.stringify({ topLevelEntries: [], pluginEntries: [] })
  )
  const mismatch = createOverlay('mismatch')
  writeFileSync(
    join(mismatch.directory, OPENCODE_OVERLAY_MANIFEST_FILE),
    JSON.stringify({ topLevelEntries: [], pluginEntries: [], sourceConfigDir: root })
  )
  expect((await sweep()).keptUnverifiable).toBe(5)
})

it('counts failed deletion attempts toward the bound and yields between them', async () => {
  for (let i = 0; i < 4; i += 1) {
    createOverlay(`retired-${i}`)
  }
  const remove = vi.fn(() => {
    throw new Error('busy')
  })
  const yieldBetween = vi.fn(async () => {})
  const result = await sweep({
    maxRemovals: 2,
    removeTree: remove,
    yieldBetweenRemovals: yieldBetween
  })
  expect(result.failed).toBe(2)
  expect(remove).toHaveBeenCalledTimes(2)
  expect(yieldBetween).toHaveBeenCalledTimes(2)
})

it('retains handed-out and inherited source references through clearPty', async () => {
  const source = join(root, 'source')
  mkdirSync(source)
  writeFileSync(join(source, 'opencode.json'), '{}')
  const service = new OpenCodeHookService(() => 'export default {}')
  const directory = service.buildPtyEnv('pane', source).OPENCODE_CONFIG_DIR
  if (!directory) {
    throw new Error('Expected overlay')
  }
  rmSync(source, { recursive: true })
  age(directory)
  service.clearPty('pane')
  expect((await service.configDirGc.run(async () => [])).keptReferenced).toBe(1)
  vi.stubEnv('ORCA_OPENCODE_SOURCE_CONFIG_DIR', source)
  expect((await new OpenCodeHookService().configDirGc.run(async () => [])).keptReferenced).toBe(1)
})

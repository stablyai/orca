import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../shared/app-environment'
import { safeRemoveTree } from '../pty/overlay-mirror'
import { OpenCodeHookService } from './hook-service'
import { OPENCODE_OVERLAY_MANIFEST_FILE } from './opencode-overlay-manifest'

let root: string
let source: string
let service: OpenCodeHookService

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-overlay-confinement-'))
  source = join(root, 'source')
  mkdirSync(join(source, 'plugins'), { recursive: true })
  writeFileSync(join(source, 'plugins', 'user.js'), 'export default {}')
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'xdg'))
  setAppEnvironment({
    getPath: () => join(root, 'profile'),
    getAppPath: () => process.cwd(),
    getVersion: () => '0.0.0-test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
  service = new OpenCodeHookService({
    pluginFileName: 'orca-test.js',
    legacyHooksDir: 'legacy-test',
    overlayDir: 'overlay-test',
    pluginSource: () => 'export default {}'
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

it.each(['overlay-root', 'source-overlay', 'plugins'] as const)(
  'preserves outside files when the owned %s is replaced by a directory link',
  (boundary) => {
    const overlay = service.buildPtyEnv('pane-1', source).OPENCODE_CONFIG_DIR
    if (!overlay) {
      throw new Error('Expected an isolated overlay')
    }
    const outside = join(root, 'outside')
    const externalOverlay = boundary === 'overlay-root' ? join(outside, basename(overlay)) : outside
    mkdirSync(join(externalOverlay, 'plugins'), { recursive: true })
    const sentinel = join(externalOverlay, 'plugins', 'keep.js')
    writeFileSync(sentinel, 'export const keep = true')
    writeFileSync(
      join(externalOverlay, OPENCODE_OVERLAY_MANIFEST_FILE),
      JSON.stringify({ topLevelEntries: [], pluginEntries: ['keep.js'] })
    )
    const replaced =
      boundary === 'overlay-root'
        ? dirname(overlay)
        : boundary === 'source-overlay'
          ? overlay
          : join(overlay, 'plugins')
    const target = boundary === 'plugins' ? join(outside, 'plugins') : outside
    if (boundary === 'plugins') {
      writeFileSync(
        join(overlay, OPENCODE_OVERLAY_MANIFEST_FILE),
        JSON.stringify({ topLevelEntries: [], pluginEntries: ['keep.js'] })
      )
    }
    safeRemoveTree(replaced)
    symlinkSync(target, replaced, process.platform === 'win32' ? 'junction' : 'dir')
    const before = readdirSync(outside, { recursive: true }).toSorted()

    const result = service.buildPtyEnv('pane-2', source)
    expect(readFileSync(sentinel, 'utf8')).toBe('export const keep = true')
    expect(readdirSync(outside, { recursive: true }).toSorted()).toEqual(before)
    expect(result).toEqual({ OPENCODE_CONFIG_DIR: source })
  }
)

it('still removes a stale mirrored entry from a real owned overlay', () => {
  const overlay = service.buildPtyEnv('pane-1', source).OPENCODE_CONFIG_DIR
  if (!overlay) {
    throw new Error('Expected an isolated overlay')
  }
  rmSync(join(source, 'plugins', 'user.js'))
  expect(service.buildPtyEnv('pane-2', source)).toEqual({ OPENCODE_CONFIG_DIR: overlay })
  expect(readdirSync(join(overlay, 'plugins'))).toEqual(['orca-test.js'])
})

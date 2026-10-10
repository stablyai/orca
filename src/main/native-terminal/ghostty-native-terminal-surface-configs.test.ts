import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeTerminalAppearance } from '../../shared/native-terminal-appearance'
import { buildGhosttyConfig } from './ghostty-native-terminal-config'
import type { GhosttyTerminalAddon } from './ghostty-native-terminal-addon'
import {
  applyGhosttySurfaceConfig,
  createGhosttySurfaceConfigFiles,
  forgetGhosttySurfaceConfig
} from './ghostty-native-terminal-surface-configs'

const userData = vi.hoisted(() => ({ dir: '' }))

vi.mock('electron', () => ({ app: { getPath: () => userData.dir } }))

const appearance: NativeTerminalAppearance = {
  fontFamily: 'Menlo',
  fontSize: 13,
  lineHeight: 1,
  letterSpacing: 0,
  cursorStyle: 'block',
  cursorBlink: false,
  scrollback: 1000,
  macOptionAsAlt: 'false',
  drawBoldTextInBrightColors: true,
  minimumContrastRatio: 1,
  mouseHideWhileTyping: false,
  copyOnSelect: false,
  paddingX: 0,
  paddingY: 0,
  theme: { background: '#000000' }
}

describe('createGhosttySurfaceConfigFiles', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-ghostty-surface-configs-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('shares one file between surfaces with the same config text', () => {
    const files = createGhosttySurfaceConfigFiles(dir)
    const text = buildGhosttyConfig(appearance, 1)
    const first = files.fileFor(1, text)
    const second = files.fileFor(2, text)
    expect(first).not.toBeNull()
    expect(second).toBe(first)
    expect(readdirSync(dir)).toHaveLength(1)
    expect(readFileSync(first ?? '', 'utf8')).toBe(text)
  })

  it('reloads a surface only when its own text changes', () => {
    const files = createGhosttySurfaceConfigFiles(dir)
    const base = buildGhosttyConfig(appearance, 1)
    const zoomed = buildGhosttyConfig({ ...appearance, fontSize: 16 }, 1)
    expect(files.fileFor(1, base)).not.toBeNull()
    expect(files.fileFor(1, base)).toBeNull()
    const zoomedPath = files.fileFor(1, zoomed)
    expect(zoomedPath).not.toBeNull()
    expect(readFileSync(zoomedPath ?? '', 'utf8')).toContain('font-size = 16\n')
    // Another pane at the default size is unaffected by this pane's zoom.
    expect(files.fileFor(2, base)).not.toBe(zoomedPath)
  })

  it('applies a forgotten surface id again', () => {
    const files = createGhosttySurfaceConfigFiles(dir)
    const text = buildGhosttyConfig(appearance, 1)
    files.fileFor(7, text)
    files.forget(7)
    expect(files.fileFor(7, text)).not.toBeNull()
  })

  it('drops earlier runs’ surface files and keeps the app config', () => {
    writeFileSync(join(dir, 'surface-stale.conf'), 'font-size = 99\n')
    writeFileSync(join(dir, 'ghostty.conf'), 'font-size = 13\n')
    const files = createGhosttySurfaceConfigFiles(dir)
    files.fileFor(1, buildGhosttyConfig(appearance, 1))
    const names = readdirSync(dir)
    expect(names).toContain('ghostty.conf')
    expect(names).not.toContain('surface-stale.conf')
    expect(names).toHaveLength(2)
  })
})

describe('applyGhosttySurfaceConfig', () => {
  afterEach(() => {
    rmSync(userData.dir, { recursive: true, force: true })
  })

  it('loads a surface config only when its text changes, and again after forget', () => {
    userData.dir = mkdtempSync(join(tmpdir(), 'orca-ghostty-user-data-'))
    const updateSurfaceConfig = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: applyGhosttySurfaceConfig only calls updateSurfaceConfig.
    const native = { updateSurfaceConfig } as unknown as GhosttyTerminalAddon
    applyGhosttySurfaceConfig(native, 3, appearance, 1)
    applyGhosttySurfaceConfig(native, 3, appearance, 1)
    applyGhosttySurfaceConfig(native, 3, appearance, 1.25)
    expect(updateSurfaceConfig).toHaveBeenCalledTimes(2)
    expect(updateSurfaceConfig.mock.calls[0][1]).toContain(join(userData.dir, 'native-terminal'))
    forgetGhosttySurfaceConfig(3)
    applyGhosttySurfaceConfig(native, 3, appearance, 1.25)
    expect(updateSurfaceConfig).toHaveBeenCalledTimes(3)
  })
})

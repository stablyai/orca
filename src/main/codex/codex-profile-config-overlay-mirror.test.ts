import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { fsFault } = vi.hoisted(() => ({
  fsFault: {
    activePublishFinalLinkError: null as { code: string; targetPath: string } | null,
    activePublishHardlinkError: null as { code: string } | null,
    activePublishProbeUnlinkFailures: 0,
    activeTargetRace: null as { contents: string; targetPath: string } | null,
    quarantineTargetRace: null as { contents: string; targetPath: string } | null,
    readdirPath: null as string | null,
    replaceWithSymlinkBeforeQuarantine: null as {
      referentPath: string
      targetPath: string
    } | null,
    restoreBeforeLink: null as { contents: string; targetPath: string } | null
  }
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    linkSync: (
      existingPath: Parameters<typeof actual.linkSync>[0],
      newPath: Parameters<typeof actual.linkSync>[1]
    ) => {
      const isActivePublishLink =
        typeof existingPath === 'string' && existingPath.includes('.orca-profile-overlay-stage-')
      const hardlinkError = fsFault.activePublishHardlinkError
      if (isActivePublishLink && hardlinkError) {
        throw Object.assign(new Error('injected active publish hard-link failure'), {
          code: hardlinkError.code
        })
      }
      const finalLinkError = fsFault.activePublishFinalLinkError
      if (
        isActivePublishLink &&
        finalLinkError &&
        typeof newPath === 'string' &&
        newPath === finalLinkError.targetPath
      ) {
        fsFault.activePublishFinalLinkError = null
        throw Object.assign(new Error('injected final active publish link failure'), {
          code: finalLinkError.code
        })
      }
      const activeRace = fsFault.activeTargetRace
      if (
        activeRace &&
        typeof existingPath === 'string' &&
        existingPath.includes('.orca-profile-overlay-stage-') &&
        typeof newPath === 'string' &&
        newPath === activeRace.targetPath
      ) {
        fsFault.activeTargetRace = null
        actual.writeFileSync(activeRace.targetPath, activeRace.contents, 'utf-8')
      }
      const race = fsFault.restoreBeforeLink
      if (
        race &&
        typeof existingPath === 'string' &&
        existingPath.includes('.orca-profile-overlay-quarantine-') &&
        typeof newPath === 'string' &&
        newPath === race.targetPath
      ) {
        fsFault.restoreBeforeLink = null
        actual.writeFileSync(race.targetPath, race.contents, 'utf-8')
      }
      actual.linkSync(existingPath, newPath)
    },
    unlinkSync: (path: Parameters<typeof actual.unlinkSync>[0]) => {
      if (
        typeof path === 'string' &&
        path.includes('.orca-profile-overlay-probe-') &&
        fsFault.activePublishProbeUnlinkFailures > 0
      ) {
        fsFault.activePublishProbeUnlinkFailures -= 1
        throw Object.assign(new Error('injected probe unlink failure'), { code: 'EACCES' })
      }
      actual.unlinkSync(path)
    },
    renameSync: (
      oldPath: Parameters<typeof actual.renameSync>[0],
      newPath: Parameters<typeof actual.renameSync>[1]
    ) => {
      const race = fsFault.replaceWithSymlinkBeforeQuarantine
      if (
        race &&
        typeof oldPath === 'string' &&
        oldPath === race.targetPath &&
        typeof newPath === 'string' &&
        newPath.includes('.orca-profile-overlay-quarantine-')
      ) {
        fsFault.replaceWithSymlinkBeforeQuarantine = null
        actual.rmSync(race.targetPath)
        actual.symlinkSync(race.referentPath, race.targetPath, 'file')
      }
      actual.renameSync(oldPath, newPath)
    },
    readdirSync: (
      path: Parameters<typeof actual.readdirSync>[0],
      options?: Parameters<typeof actual.readdirSync>[1]
    ) => {
      if (typeof path === 'string' && fsFault.readdirPath === path) {
        fsFault.readdirPath = null
        throw Object.assign(new Error('injected readdir failure'), { code: 'EACCES' })
      }
      return options === undefined
        ? actual.readdirSync(path)
        : actual.readdirSync(path, options as never)
    },
    readFileSync: (
      path: Parameters<typeof actual.readFileSync>[0],
      options?: Parameters<typeof actual.readFileSync>[1]
    ) => {
      const contents =
        options === undefined ? actual.readFileSync(path) : actual.readFileSync(path, options)
      const race = fsFault.quarantineTargetRace
      if (race && typeof path === 'string' && path.includes('.orca-profile-overlay-quarantine-')) {
        fsFault.quarantineTargetRace = null
        actual.writeFileSync(race.targetPath, race.contents, 'utf-8')
      }
      return contents
    }
  }
})

import { syncCodexProfileConfigOverlaysIntoManagedHome } from './codex-profile-config-overlay-mirror'

let rootPath: string
let runtimeHomePath: string
let systemHomePath: string

beforeEach(() => {
  fsFault.activePublishFinalLinkError = null
  fsFault.activePublishHardlinkError = null
  fsFault.activePublishProbeUnlinkFailures = 0
  fsFault.activeTargetRace = null
  fsFault.quarantineTargetRace = null
  fsFault.readdirPath = null
  fsFault.replaceWithSymlinkBeforeQuarantine = null
  fsFault.restoreBeforeLink = null
  rootPath = mkdtempSync(join(tmpdir(), 'orca-profile-overlay-mirror-'))
  runtimeHomePath = join(rootPath, 'runtime')
  systemHomePath = join(rootPath, 'system')
  mkdirSync(systemHomePath, { recursive: true })
})

afterEach(() => {
  fsFault.activePublishFinalLinkError = null
  fsFault.activePublishHardlinkError = null
  fsFault.activePublishProbeUnlinkFailures = 0
  fsFault.activeTargetRace = null
  fsFault.quarantineTargetRace = null
  fsFault.readdirPath = null
  fsFault.replaceWithSymlinkBeforeQuarantine = null
  fsFault.restoreBeforeLink = null
  rmSync(rootPath, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function syncOverlays(): void {
  syncCodexProfileConfigOverlaysIntoManagedHome({
    runtimeHomePath,
    sourceConfigDir: systemHomePath,
    systemHomePath
  })
}

function sourceOverlayPath(fileName = 'work.config.toml'): string {
  return join(systemHomePath, fileName)
}

function runtimeOverlayPath(fileName = 'work.config.toml'): string {
  return join(runtimeHomePath, fileName)
}

function sha256(contents: string): string {
  return createHash('sha256').update(contents, 'utf-8').digest('hex')
}

function readManagedOverlay(fileName = 'work.config.toml'): {
  body: string
  hasBom: boolean
  markerHash: string
} {
  const contents = readFileSync(runtimeOverlayPath(fileName), 'utf-8')
  const hasBom = contents.startsWith('\uFEFF')
  const withoutBom = hasBom ? contents.slice(1) : contents
  const marker = withoutBom.match(/^# orca-managed-profile-overlay:v1 sha256=([a-f0-9]{64})\n/)
  if (!marker) {
    throw new Error('managed profile overlay marker is missing')
  }
  return {
    body: withoutBom.slice(marker[0].length),
    hasBom,
    markerHash: marker[1]!
  }
}

function listOverlayQuarantines(): string[] {
  return readdirSync(runtimeHomePath).filter((name) => name.includes('overlay-quarantine'))
}

describe('syncCodexProfileConfigOverlaysIntoManagedHome', () => {
  it('binds a versioned ownership marker to the final path and auth rewritten body', () => {
    writeFileSync(
      sourceOverlayPath(),
      'cli_auth_credentials_store = "keyring"\nlog_dir = "logs"\n',
      'utf-8'
    )

    syncOverlays()

    const managed = readManagedOverlay()
    expect(managed.hasBom).toBe(false)
    expect(managed.body).toContain('cli_auth_credentials_store = "file"')
    expect(managed.body).toContain(`log_dir = '${join(systemHomePath, 'logs')}'`)
    expect(managed.markerHash).toBe(sha256(managed.body))
    expect(readdirSync(runtimeHomePath)).not.toContain(
      '.orca-profile-config-overlay-ownership.json'
    )
  })

  it('keeps a BOM at char zero with the ownership marker immediately after it', () => {
    writeFileSync(
      sourceOverlayPath(),
      '\uFEFFcli_auth_credentials_store = "keyring"\nmodel = "work"\n',
      'utf-8'
    )

    syncOverlays()

    const contents = readFileSync(runtimeOverlayPath(), 'utf-8')
    expect(contents[0]).toBe('\uFEFF')
    expect(contents.slice(1)).toMatch(/^# orca-managed-profile-overlay:v1 sha256=/)
    const managed = readManagedOverlay()
    expect(managed.hasBom).toBe(true)
    expect(managed.body).toContain('cli_auth_credentials_store = "file"')
    expect(managed.markerHash).toBe(sha256(managed.body))
  })

  it('removes marked overlays after their source is renamed or deleted', () => {
    const workSourcePath = sourceOverlayPath()
    const focusSourcePath = sourceOverlayPath('focus.config.toml')
    writeFileSync(workSourcePath, 'model = "work"\n', 'utf-8')
    syncOverlays()

    renameSync(workSourcePath, focusSourcePath)
    syncOverlays()
    expect(existsSync(runtimeOverlayPath())).toBe(false)
    expect(readManagedOverlay('focus.config.toml').body).toContain('model = "work"')

    rmSync(focusSourcePath)
    syncOverlays()
    expect(existsSync(runtimeOverlayPath('focus.config.toml'))).toBe(false)
  })

  it('restores an unmarked stale regular overlay after quarantine inspection', () => {
    mkdirSync(runtimeHomePath, { recursive: true })
    const userContents = 'model = "user-owned"\n'
    writeFileSync(runtimeOverlayPath(), userContents, 'utf-8')

    syncOverlays()

    expect(readFileSync(runtimeOverlayPath(), 'utf-8')).toBe(userContents)
    expect(listOverlayQuarantines()).toEqual([])
  })

  it('restores a modified stale overlay whose body no longer matches its marker hash', () => {
    writeFileSync(sourceOverlayPath(), 'model = "managed"\n', 'utf-8')
    syncOverlays()
    const modified = readFileSync(runtimeOverlayPath(), 'utf-8').replace(
      'model = "managed"',
      'model = "user-edit"'
    )
    writeFileSync(runtimeOverlayPath(), modified, 'utf-8')
    rmSync(sourceOverlayPath())

    syncOverlays()

    expect(readFileSync(runtimeOverlayPath(), 'utf-8')).toBe(modified)
    expect(listOverlayQuarantines()).toEqual([])
  })

  it('replaces an active regular target using the managed atomic writer', () => {
    writeFileSync(sourceOverlayPath(), 'model = "managed"\n', 'utf-8')
    mkdirSync(runtimeHomePath, { recursive: true })
    writeFileSync(runtimeOverlayPath(), 'model = "old-runtime-copy"\n', 'utf-8')

    syncOverlays()

    const managed = readManagedOverlay()
    expect(managed.body).toContain('model = "managed"')
    expect(managed.body).not.toContain('old-runtime-copy')
  })

  it('keeps the active target when hard links are unavailable before quarantine', () => {
    writeFileSync(sourceOverlayPath(), 'model = "managed"\n', 'utf-8')
    mkdirSync(runtimeHomePath, { recursive: true })
    const oldContents = 'model = "old-runtime-copy"\n'
    writeFileSync(runtimeOverlayPath(), oldContents, 'utf-8')
    fsFault.activePublishHardlinkError = { code: 'EPERM' }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    syncOverlays()

    expect(readFileSync(runtimeOverlayPath(), 'utf-8')).toBe(oldContents)
    expect(listOverlayQuarantines()).toEqual([])
    expect(
      readdirSync(runtimeHomePath).filter(
        (name) => name.includes('overlay-stage') || name.includes('overlay-probe')
      )
    ).toEqual([])
    expect(warn).toHaveBeenCalled()
  })

  it('retries cleanup after a one-shot hard-link probe unlink failure', () => {
    writeFileSync(sourceOverlayPath(), 'model = "managed"\n', 'utf-8')
    mkdirSync(runtimeHomePath, { recursive: true })
    const oldContents = 'model = "old-runtime-copy"\n'
    writeFileSync(runtimeOverlayPath(), oldContents, 'utf-8')
    fsFault.activePublishProbeUnlinkFailures = 1
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    syncOverlays()

    expect(readFileSync(runtimeOverlayPath(), 'utf-8')).toBe(oldContents)
    expect(
      readdirSync(runtimeHomePath).filter(
        (name) => name.includes('overlay-stage') || name.includes('overlay-probe')
      )
    ).toEqual([])
    expect(warn).toHaveBeenCalled()
  })

  it('does not accumulate hard-link probes after persistent unlink failures', () => {
    writeFileSync(sourceOverlayPath(), 'model = "managed"\n', 'utf-8')
    mkdirSync(runtimeHomePath, { recursive: true })
    const oldContents = 'model = "old-runtime-copy"\n'
    writeFileSync(runtimeOverlayPath(), oldContents, 'utf-8')
    fsFault.activePublishProbeUnlinkFailures = 4
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    syncOverlays()
    syncOverlays()

    expect(readFileSync(runtimeOverlayPath(), 'utf-8')).toBe(oldContents)
    expect(
      readdirSync(runtimeHomePath).filter((name) => name.includes('overlay-probe'))
    ).toHaveLength(1)
    expect(readdirSync(runtimeHomePath).some((name) => name.includes('overlay-stage'))).toBe(false)
  })

  it('restores the active target after a one-shot final publish failure', () => {
    writeFileSync(sourceOverlayPath(), 'model = "managed"\n', 'utf-8')
    mkdirSync(runtimeHomePath, { recursive: true })
    const oldContents = 'model = "old-runtime-copy"\n'
    writeFileSync(runtimeOverlayPath(), oldContents, 'utf-8')
    fsFault.activePublishFinalLinkError = {
      code: 'EIO',
      targetPath: runtimeOverlayPath()
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    syncOverlays()

    expect(fsFault.activePublishFinalLinkError).toBeNull()
    expect(readFileSync(runtimeOverlayPath(), 'utf-8')).toBe(oldContents)
    expect(listOverlayQuarantines()).toEqual([])
    expect(
      readdirSync(runtimeHomePath).filter(
        (name) => name.includes('overlay-stage') || name.includes('overlay-probe')
      )
    ).toEqual([])
    expect(warn).toHaveBeenCalled()
  })

  it('does not overwrite a regular target created immediately before active publish', () => {
    writeFileSync(sourceOverlayPath(), 'model = "managed"\n', 'utf-8')
    mkdirSync(runtimeHomePath, { recursive: true })
    const oldContents = 'model = "old-runtime-copy"\n'
    const concurrentContents = 'model = "concurrent-owner"\n'
    writeFileSync(runtimeOverlayPath(), oldContents, 'utf-8')
    fsFault.activeTargetRace = {
      contents: concurrentContents,
      targetPath: runtimeOverlayPath()
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    syncOverlays()

    expect(fsFault.activeTargetRace).toBeNull()
    expect(readFileSync(runtimeOverlayPath(), 'utf-8')).toBe(concurrentContents)
    const quarantines = listOverlayQuarantines()
    expect(quarantines).toHaveLength(1)
    expect(readFileSync(join(runtimeHomePath, quarantines[0]!), 'utf-8')).toBe(oldContents)
    expect(readdirSync(runtimeHomePath).some((name) => name.includes('overlay-stage'))).toBe(false)
    expect(warn).toHaveBeenCalled()
  })

  it('does not replace an active symlink swapped in immediately before quarantine', () => {
    writeFileSync(sourceOverlayPath(), 'model = "managed"\n', 'utf-8')
    mkdirSync(runtimeHomePath, { recursive: true })
    writeFileSync(runtimeOverlayPath(), 'model = "initial-regular"\n', 'utf-8')
    const referentPath = join(rootPath, 'active-concurrent-owner.config.toml')
    const referentContents = 'model = "concurrent-owner"\n'
    writeFileSync(referentPath, referentContents, 'utf-8')
    fsFault.replaceWithSymlinkBeforeQuarantine = {
      referentPath,
      targetPath: runtimeOverlayPath()
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    syncOverlays()

    expect(fsFault.replaceWithSymlinkBeforeQuarantine).toBeNull()
    expect(existsSync(runtimeOverlayPath())).toBe(false)
    const quarantines = listOverlayQuarantines()
    expect(quarantines).toHaveLength(1)
    const quarantinePath = join(runtimeHomePath, quarantines[0]!)
    expect(lstatSync(quarantinePath).isSymbolicLink()).toBe(true)
    expect(readFileSync(quarantinePath, 'utf-8')).toBe(referentContents)
    expect(readFileSync(referentPath, 'utf-8')).toBe(referentContents)
    expect(warn).toHaveBeenCalled()
  })

  it('warns and skips an active symlink target', () => {
    writeFileSync(sourceOverlayPath(), 'model = "managed"\n', 'utf-8')
    mkdirSync(runtimeHomePath, { recursive: true })
    const userFilePath = join(rootPath, 'user-owned.config.toml')
    writeFileSync(userFilePath, 'model = "user-owned"\n', 'utf-8')
    symlinkSync(userFilePath, runtimeOverlayPath(), 'file')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    syncOverlays()

    expect(lstatSync(runtimeOverlayPath()).isSymbolicLink()).toBe(true)
    expect(readFileSync(userFilePath, 'utf-8')).toBe('model = "user-owned"\n')
    expect(warn).toHaveBeenCalled()
  })

  it('warns and skips an active directory target', () => {
    writeFileSync(sourceOverlayPath(), 'model = "managed"\n', 'utf-8')
    mkdirSync(runtimeOverlayPath(), { recursive: true })
    writeFileSync(join(runtimeOverlayPath(), 'keep.txt'), 'keep', 'utf-8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    syncOverlays()

    expect(readFileSync(join(runtimeOverlayPath(), 'keep.txt'), 'utf-8')).toBe('keep')
    expect(warn).toHaveBeenCalled()
  })

  it('ignores stale non-regular overlays and unrelated regular files', () => {
    mkdirSync(runtimeHomePath, { recursive: true })
    const userFilePath = join(rootPath, 'user-owned.config.toml')
    const linkPath = runtimeOverlayPath('link.config.toml')
    const directoryPath = runtimeOverlayPath('folder.config.toml')
    const unrelatedPath = join(runtimeHomePath, 'notes.toml')
    writeFileSync(userFilePath, 'model = "user-owned"\n', 'utf-8')
    symlinkSync(userFilePath, linkPath, 'file')
    mkdirSync(directoryPath)
    writeFileSync(join(directoryPath, 'keep.txt'), 'keep', 'utf-8')
    writeFileSync(unrelatedPath, 'keep', 'utf-8')

    syncOverlays()

    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(directoryPath, 'keep.txt'), 'utf-8')).toBe('keep')
    expect(readFileSync(unrelatedPath, 'utf-8')).toBe('keep')
  })

  it('does not clean stale overlays when the system home cannot be listed', () => {
    writeFileSync(sourceOverlayPath(), 'model = "managed"\n', 'utf-8')
    syncOverlays()
    rmSync(sourceOverlayPath())
    fsFault.readdirPath = systemHomePath

    syncOverlays()

    expect(fsFault.readdirPath).toBeNull()
    expect(readManagedOverlay().body).toContain('model = "managed"')
  })

  it('retains quarantine without overwriting a concurrent target', () => {
    mkdirSync(runtimeHomePath, { recursive: true })
    const originalContents = 'model = "user-owned"\n'
    const concurrentContents = 'model = "concurrent-owner"\n'
    writeFileSync(runtimeOverlayPath(), originalContents, 'utf-8')
    fsFault.quarantineTargetRace = {
      contents: concurrentContents,
      targetPath: runtimeOverlayPath()
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    syncOverlays()

    expect(fsFault.quarantineTargetRace).toBeNull()
    expect(readFileSync(runtimeOverlayPath(), 'utf-8')).toBe(concurrentContents)
    const quarantines = listOverlayQuarantines()
    expect(quarantines).toHaveLength(1)
    expect(readFileSync(join(runtimeHomePath, quarantines[0]!), 'utf-8')).toBe(originalContents)
    expect(warn).toHaveBeenCalled()
  })

  it('retains a symlink swapped in immediately before quarantine', () => {
    mkdirSync(runtimeHomePath, { recursive: true })
    writeFileSync(runtimeOverlayPath(), 'model = "initial-regular"\n', 'utf-8')
    const referentPath = join(rootPath, 'concurrent-owner.config.toml')
    const referentContents = 'model = "concurrent-owner"\n'
    writeFileSync(referentPath, referentContents, 'utf-8')
    fsFault.replaceWithSymlinkBeforeQuarantine = {
      referentPath,
      targetPath: runtimeOverlayPath()
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    syncOverlays()

    expect(fsFault.replaceWithSymlinkBeforeQuarantine).toBeNull()
    expect(existsSync(runtimeOverlayPath())).toBe(false)
    const quarantines = listOverlayQuarantines()
    expect(quarantines).toHaveLength(1)
    const quarantinePath = join(runtimeHomePath, quarantines[0]!)
    expect(lstatSync(quarantinePath).isSymbolicLink()).toBe(true)
    expect(readFileSync(quarantinePath, 'utf-8')).toBe(referentContents)
    expect(readFileSync(referentPath, 'utf-8')).toBe(referentContents)
    expect(warn).toHaveBeenCalled()
  })

  it('does not overwrite a target created immediately before atomic restore', () => {
    mkdirSync(runtimeHomePath, { recursive: true })
    const originalContents = 'model = "user-owned"\n'
    const concurrentContents = 'model = "late-concurrent-owner"\n'
    writeFileSync(runtimeOverlayPath(), originalContents, 'utf-8')
    fsFault.restoreBeforeLink = {
      contents: concurrentContents,
      targetPath: runtimeOverlayPath()
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    syncOverlays()

    expect(fsFault.restoreBeforeLink).toBeNull()
    expect(readFileSync(runtimeOverlayPath(), 'utf-8')).toBe(concurrentContents)
    const quarantines = listOverlayQuarantines()
    expect(quarantines).toHaveLength(1)
    expect(readFileSync(join(runtimeHomePath, quarantines[0]!), 'utf-8')).toBe(originalContents)
    expect(warn).toHaveBeenCalled()
  })

  it('matches overlay filenames case-insensitively on Windows', () => {
    const lowerSourcePath = sourceOverlayPath()
    writeFileSync(lowerSourcePath, 'model = "lower"\n', 'utf-8')
    syncOverlays()
    rmSync(lowerSourcePath)
    writeFileSync(sourceOverlayPath('WORK.CONFIG.TOML'), 'model = "upper"\n', 'utf-8')
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')

    syncOverlays()

    expect(existsSync(runtimeOverlayPath())).toBe(true)
    expect(listOverlayQuarantines()).toEqual([])
    platform.mockRestore()
  })
})

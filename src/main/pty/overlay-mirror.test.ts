import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type * as NodePath from 'node:path'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { safeRemoveOverlay } from './overlay-mirror'

const tempRoots: string[] = []

afterEach(() => {
  vi.doUnmock('fs')
  vi.doUnmock('path')
  vi.restoreAllMocks()
  vi.resetModules()
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('safeRemoveOverlay', () => {
  it('removes valid overlay children whose names start with dot-dot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-overlay-root-'))
    tempRoots.push(root)
    const overlayDir = join(root, '..session-overlay')
    mkdirSync(overlayDir, { recursive: true })
    writeFileSync(join(overlayDir, 'marker.txt'), 'overlay')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    safeRemoveOverlay(overlayDir, root)

    expect(existsSync(overlayDir)).toBe(false)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('refuses to remove the overlay root itself', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-overlay-root-'))
    tempRoots.push(root)
    const marker = join(root, 'marker.txt')
    writeFileSync(marker, 'root')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    safeRemoveOverlay(root, root)

    expect(existsSync(marker)).toBe(true)
    expect(warnSpy).toHaveBeenCalledOnce()
  })

  it('refuses parent traversal outside the overlay root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'orca-overlay-parent-'))
    tempRoots.push(parent)
    const root = join(parent, 'root')
    const outside = join(parent, 'outside')
    mkdirSync(root)
    mkdirSync(outside)
    const marker = join(outside, 'marker.txt')
    writeFileSync(marker, 'outside')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    safeRemoveOverlay(join(root, '..', 'outside'), root)

    expect(existsSync(marker)).toBe(true)
    expect(warnSpy).toHaveBeenCalledOnce()
  })

  it('refuses Windows overlay targets on a different drive than the root', async () => {
    const lstatSyncMock = vi.fn(() => ({
      isSymbolicLink: () => false,
      isDirectory: () => false
    }))
    const unlinkSyncMock = vi.fn()
    vi.doMock('fs', () => ({
      cpSync: vi.fn(),
      linkSync: vi.fn(),
      lstatSync: lstatSyncMock,
      readdirSync: vi.fn(),
      rmdirSync: vi.fn(),
      symlinkSync: vi.fn(),
      unlinkSync: unlinkSyncMock
    }))
    vi.doMock('path', async () => {
      const path = await vi.importActual<typeof NodePath>('node:path')
      return {
        ...path.win32,
        default: path.win32
      }
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { safeRemoveOverlay: safeRemoveOverlayWithWinPath } = await import('./overlay-mirror')
    safeRemoveOverlayWithWinPath(String.raw`D:\users\me\config`, String.raw`C:\orca\overlays`)

    expect(warnSpy).toHaveBeenCalledWith(
      '[overlay-mirror] refusing to remove overlay outside root: target=D:\\users\\me\\config root=C:\\orca\\overlays'
    )
    expect(lstatSyncMock).not.toHaveBeenCalled()
    expect(unlinkSyncMock).not.toHaveBeenCalled()
  })
})

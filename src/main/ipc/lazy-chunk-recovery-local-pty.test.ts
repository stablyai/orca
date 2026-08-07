// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCA_RENDERER_UNLOAD_PREVENTED_EVENT } from '../../shared/renderer-shutdown-events'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node-pty', () => ({ spawn: spawnMock }))
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/orca-test' } }))
vi.mock('../providers/macos-tcc-login-shell', () => ({
  prepareMacosTccLoginShell: () => Promise.resolve(),
  wrapShellSpawnForMacosTccAttribution: (file: string, args: string[]) => ({ file, args })
}))
vi.mock('../pty/posix-pty-process-groups', () => ({
  forceKillPosixPtyProcessGroups: (_pid: number, killRoot: () => void) => killRoot()
}))

import {
  _resetLocalPtyProviderStateForTest,
  LocalPtyProvider
} from '../providers/local-pty-provider'
import { requestLazyChunkRecoveryReload } from '../../renderer/src/lib/lazy-chunk-recovery-reload'
import { createRecoveryReloadIntent } from '../window/recovery-reload-intent'
import { handleLocalPtyRendererLoad } from './local-pty-renderer-load'

describe('lazy chunk recovery local PTY load', () => {
  const webContentsId = 7
  const kill = vi.fn()
  const proc = {
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill,
    process: 'zsh',
    pid: 12345
  }

  async function spawnStaleGenerationPty(provider: LocalPtyProvider): Promise<string> {
    const spawned = await provider.spawn({ cols: 80, rows: 24 })
    handleLocalPtyRendererLoad(provider, webContentsId, () => 'recovery')
    await provider.spawn({ cols: 100, rows: 30, sessionId: spawned.id })
    return spawned.id
  }

  beforeEach(() => {
    kill.mockReset()
    proc.resize.mockReset()
    spawnMock.mockReset().mockReturnValue(proc)
  })

  afterEach(() => {
    _resetLocalPtyProviderStateForTest()
    vi.restoreAllMocks()
    delete (window as unknown as { api?: unknown }).api
  })

  it('preserves a re-adopted older-generation PTY across lazy recovery', async () => {
    const provider = new LocalPtyProvider()
    const spawnedId = await spawnStaleGenerationPty(provider)
    const intent = createRecoveryReloadIntent({
      now: () => 100,
      createToken: () => 'intent-1',
      durationMs: 50
    })
    Object.assign(window, {
      api: {
        app: {
          beginLazyChunkRecoveryReload: async () => intent.begin(webContentsId),
          cancelLazyChunkRecoveryReload: async (token: string) =>
            intent.cancel(webContentsId, token)
        }
      }
    })
    vi.spyOn(window.location, 'reload').mockImplementation(() => {
      intent.noteNavigationStarted(webContentsId)
      handleLocalPtyRendererLoad(provider, webContentsId, intent.classifyLoad)
      window.dispatchEvent(new Event(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT))
    })

    await expect(requestLazyChunkRecoveryReload(window, async () => undefined)).resolves.toBe(
      'unload-vetoed'
    )

    expect(kill).not.toHaveBeenCalled()
    expect(provider.hasPty(spawnedId)).toBe(true)
  })

  it('does not let an intervening load consume the recovery protection', async () => {
    const provider = new LocalPtyProvider()
    const spawnedId = await spawnStaleGenerationPty(provider)
    const intent = createRecoveryReloadIntent({
      now: () => 100,
      createToken: () => 'intent-1',
      durationMs: 50
    })
    Object.assign(window, {
      api: {
        app: {
          beginLazyChunkRecoveryReload: async () => intent.begin(webContentsId),
          cancelLazyChunkRecoveryReload: async (token: string) =>
            intent.cancel(webContentsId, token)
        }
      }
    })
    vi.spyOn(window.location, 'reload').mockImplementation(() => {
      handleLocalPtyRendererLoad(provider, webContentsId, intent.classifyLoad)
      intent.noteNavigationStarted(webContentsId)
      handleLocalPtyRendererLoad(provider, webContentsId, intent.classifyLoad)
      window.dispatchEvent(new Event(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT))
    })

    await expect(requestLazyChunkRecoveryReload(window, async () => undefined)).resolves.toBe(
      'unload-vetoed'
    )

    expect(kill).not.toHaveBeenCalled()
    expect(provider.hasPty(spawnedId)).toBe(true)
  })

  it('preserves the PTY when the recovery intent expires before navigation', async () => {
    let now = 100
    const provider = new LocalPtyProvider()
    const spawnedId = await spawnStaleGenerationPty(provider)
    const intent = createRecoveryReloadIntent({
      now: () => now,
      createToken: () => 'intent-1',
      durationMs: 50
    })
    Object.assign(window, {
      api: {
        app: {
          beginLazyChunkRecoveryReload: async () => intent.begin(webContentsId),
          cancelLazyChunkRecoveryReload: async (token: string) =>
            intent.cancel(webContentsId, token)
        }
      }
    })
    vi.spyOn(window.location, 'reload').mockImplementation(() => {
      now = 151
      intent.noteNavigationStarted(webContentsId)
      handleLocalPtyRendererLoad(provider, webContentsId, intent.classifyLoad)
      window.dispatchEvent(new Event(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT))
    })

    await expect(requestLazyChunkRecoveryReload(window, async () => undefined)).resolves.toBe(
      'unload-vetoed'
    )

    expect(kill).not.toHaveBeenCalled()
    expect(provider.hasPty(spawnedId)).toBe(true)
  })

  it('preserves the PTY when recovery and ordinary reload arms overlap', async () => {
    const provider = new LocalPtyProvider()
    const spawnedId = await spawnStaleGenerationPty(provider)
    const intent = createRecoveryReloadIntent({
      now: () => 100,
      createToken: () => 'intent-1',
      durationMs: 50
    })

    intent.begin(webContentsId)
    intent.armOrdinary(webContentsId)
    intent.noteNavigationStarted(webContentsId)
    handleLocalPtyRendererLoad(provider, webContentsId, intent.classifyLoad)

    expect(kill).not.toHaveBeenCalled()
    expect(provider.hasPty(spawnedId)).toBe(true)
  })

  // Unsatisfiable as written: a vetoed reload is indistinguishable from a real navigation
  // unless the veto path cancels the arm. Wiring that caller is the remaining work.
  it.todo('does not let an abandoned ordinary reload authorize a later sweep')


  it('isolates concurrent recovery intents by webContents', async () => {
    const provider = new LocalPtyProvider()
    const spawnedId = await spawnStaleGenerationPty(provider)
    let token = 0
    const intent = createRecoveryReloadIntent({
      now: () => 100,
      createToken: () => `intent-${++token}`,
      durationMs: 50
    })

    intent.begin(webContentsId)
    intent.begin(8)
    intent.noteNavigationStarted(webContentsId)
    handleLocalPtyRendererLoad(provider, webContentsId, intent.classifyLoad)
    intent.noteNavigationStarted(8)
    handleLocalPtyRendererLoad(provider, 8, intent.classifyLoad)

    expect(kill).not.toHaveBeenCalled()
    expect(provider.hasPty(spawnedId)).toBe(true)
  })

  it('preserves the PTY for an unknown load classification', async () => {
    const provider = new LocalPtyProvider()
    const spawnedId = await spawnStaleGenerationPty(provider)

    handleLocalPtyRendererLoad(provider, webContentsId, () => 'unknown')

    expect(kill).not.toHaveBeenCalled()
    expect(provider.hasPty(spawnedId)).toBe(true)
  })

  it('sweeps only after a positively classified ordinary navigation', async () => {
    const provider = new LocalPtyProvider()
    await spawnStaleGenerationPty(provider)
    const intent = createRecoveryReloadIntent({
      now: () => 100,
      createToken: () => 'intent-1',
      durationMs: 50
    })
    Object.assign(window, {
      api: {
        app: {
          beginLazyChunkRecoveryReload: async () => intent.begin(webContentsId),
          cancelLazyChunkRecoveryReload: async (token: string) =>
            intent.cancel(webContentsId, token)
        }
      }
    })
    vi.spyOn(window.location, 'reload').mockImplementation(() => {
      window.dispatchEvent(new Event(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT))
    })

    await expect(requestLazyChunkRecoveryReload(window, async () => undefined)).resolves.toBe(
      'unload-vetoed'
    )
    intent.armOrdinary(webContentsId)
    intent.noteNavigationStarted(webContentsId)
    handleLocalPtyRendererLoad(provider, webContentsId, intent.classifyLoad)

    expect(kill).toHaveBeenCalledTimes(1)
  })
})

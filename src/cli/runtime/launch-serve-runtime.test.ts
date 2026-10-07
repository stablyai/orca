import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, resolveLocalServeRuntimeMock, serveWithOrcadMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  resolveLocalServeRuntimeMock: vi.fn(),
  serveWithOrcadMock: vi.fn()
}))

vi.mock('child_process', () => ({ spawn: spawnMock, spawnSync: vi.fn() }))
vi.mock('./serve-orcad-launch', () => ({
  resolveLocalServeRuntime: resolveLocalServeRuntimeMock,
  serveWithOrcad: serveWithOrcadMock
}))

import { serveOrcaApp } from './launch'

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter()
  kill = vi.fn()
  unref = vi.fn()
  pid = 4101
}

/** Electron serve that exits cleanly once spawned, whenever selection gets to spawning it. */
function electronChild(): void {
  spawnMock.mockImplementation(() => {
    const child = new FakeChildProcess()
    setTimeout(() => child.emit('exit', 0, null), 0)
    return child
  })
}

describe('orca serve host selection', () => {
  let stderr: string[]

  beforeEach(() => {
    spawnMock.mockReset()
    resolveLocalServeRuntimeMock.mockReset()
    serveWithOrcadMock.mockReset()
    process.env.ORCA_APP_EXECUTABLE = '/opt/orca/orca-ide'
    stderr = []
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk))
      return true
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.ORCA_APP_EXECUTABLE
    delete process.env.ORCA_SERVE_RUNTIME
  })

  it('serves on orcad by default', async () => {
    const selection = { kind: 'orcad', runtime: '/node', entry: '/slot/orcad.js', version: '1' }
    resolveLocalServeRuntimeMock.mockResolvedValue(selection)
    serveWithOrcadMock.mockResolvedValue(0)

    await expect(serveOrcaApp({ json: true })).resolves.toBe(0)
    expect(serveWithOrcadMock).toHaveBeenCalledWith(
      selection,
      { json: true },
      expect.any(String),
      expect.not.objectContaining({ ELECTRON_RUN_AS_NODE: expect.anything() })
    )
    expect(spawnMock).not.toHaveBeenCalled()
    expect(stderr.join('')).toContain('[serve] running on orcad 1')
  })

  it('falls back to Electron and prints why when orcad cannot serve', async () => {
    resolveLocalServeRuntimeMock.mockResolvedValue({ kind: 'electron', reason: 'no template' })
    electronChild()

    await expect(serveOrcaApp({ json: true })).resolves.toBe(0)
    expect(spawnMock).toHaveBeenCalledWith(
      '/opt/orca/orca-ide',
      expect.arrayContaining(['--serve', '--serve-json']),
      expect.any(Object)
    )
    expect(stderr.join('')).toContain('[serve] using Electron serve: no template')
  })

  it('keeps Electron without asking orcad when ORCA_SERVE_RUNTIME=electron', async () => {
    process.env.ORCA_SERVE_RUNTIME = 'electron'
    electronChild()

    await expect(serveOrcaApp({ json: true })).resolves.toBe(0)
    expect(resolveLocalServeRuntimeMock).not.toHaveBeenCalled()
    expect(spawnMock).toHaveBeenCalledOnce()
    expect(stderr.join('')).not.toContain('[serve]')
  })
})

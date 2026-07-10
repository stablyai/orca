import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { showMessageBoxMock, getPathMock, inspectorPostMock } = vi.hoisted(() => ({
  showMessageBoxMock: vi.fn(),
  getPathMock: vi.fn(),
  inspectorPostMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: getPathMock, getVersion: () => '1.2.3-test' },
  dialog: { showMessageBox: showMessageBoxMock }
}))

// Why: the profile stage waits 10 s in production; tests must not.
vi.mock('node:timers/promises', () => ({ setTimeout: async () => {} }))

vi.mock('node:inspector', () => ({
  Session: class {
    connect(): void {}
    disconnect(): void {}
    post(
      method: string,
      params: object | undefined,
      callback: (error: Error | null, result?: unknown) => void
    ): void {
      inspectorPostMock(method, params, callback)
    }
  }
}))

vi.mock('./renderer-perf', () => ({
  collectRendererPerfMetrics: vi.fn(async () => ({
    type: 'renderer-perf',
    schema_version: 1,
    collected_at: '2026-01-01T00:00:00.000Z'
  }))
}))

vi.mock('../i18n/main-i18n', () => ({
  translateMain: (_key: string, fallback: string) => fallback
}))

import { captureRendererPerfDump } from './perf-dump'

let tempRoot: string
let downloadsDir: string

type RendererDebuggerMock = {
  isAttached: ReturnType<typeof vi.fn>
  attach: ReturnType<typeof vi.fn>
  detach: ReturnType<typeof vi.fn>
  sendCommand: ReturnType<typeof vi.fn>
}

function makeRendererDebugger(
  overrides: Partial<Record<string, unknown>> = {}
): RendererDebuggerMock {
  let attached = false
  return {
    isAttached: vi.fn(() => attached),
    attach: vi.fn(() => {
      attached = true
    }),
    detach: vi.fn(() => {
      attached = false
    }),
    sendCommand: vi.fn(async (method: string) =>
      method === 'Profiler.stop' ? { profile: { nodes: [], samples: [1] } } : undefined
    ),
    ...overrides
  }
}

function makeRenderer(dbg: RendererDebuggerMock = makeRendererDebugger()): unknown {
  return {
    isDestroyed: () => false,
    debugger: dbg
  }
}

function stubInspectorPost(
  impl: (method: string) => unknown = (method) =>
    method === 'Profiler.stop' ? { profile: { nodes: [], samples: [2] } } : undefined
): void {
  inspectorPostMock.mockImplementation(
    (
      method: string,
      _params: object | undefined,
      callback: (error: Error | null, result?: unknown) => void
    ) => {
      try {
        callback(null, impl(method))
      } catch (error) {
        callback(error as Error)
      }
    }
  )
}

function readTarEntries(archive: Buffer): Map<string, string> {
  const tar = gunzipSync(archive)
  const entries = new Map<string, string>()
  let offset = 0
  while (offset + 512 <= tar.length) {
    const name = tar
      .subarray(offset, offset + 100)
      .toString('utf8')
      .split('\0')[0]
    if (!name) {
      break
    }
    const size = Number.parseInt(tar.subarray(offset + 124, offset + 136).toString('ascii'), 8)
    entries.set(name, tar.subarray(offset + 512, offset + 512 + size).toString('utf8'))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return entries
}

describe('captureRendererPerfDump', () => {
  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), 'orca-perf-dump-test-'))
    downloadsDir = join(tempRoot, 'downloads')
    await mkdir(downloadsDir, { recursive: true })
    getPathMock.mockImplementation((name: string) =>
      name === 'downloads' ? downloadsDir : join(tempRoot, name)
    )
    showMessageBoxMock.mockResolvedValue({ response: 0 })
    stubInspectorPost()
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('produces a tar.gz containing metadata, metrics, and both CPU profiles', async () => {
    const result = await captureRendererPerfDump({
      getRendererWebContents: () => makeRenderer() as never
    })

    expect(result).not.toHaveProperty('canceled')
    const { filePath, bytes } = result as { filePath: string; bytes: number }
    expect(bytes).toBeGreaterThan(0)
    const entries = readTarEntries(await readFile(filePath))
    expect([...entries.keys()]).toEqual([
      'metadata.json',
      'renderer-perf-metrics.json',
      'renderer.cpuprofile',
      'main.cpuprofile'
    ])
    expect(JSON.parse(entries.get('renderer.cpuprofile')!)).toEqual({ nodes: [], samples: [1] })
    expect(JSON.parse(entries.get('main.cpuprofile')!)).toEqual({ nodes: [], samples: [2] })
    // Temp capture directory is removed after packaging.
    expect(await readdir(join(tempRoot, 'temp', 'orca-perf-dumps'))).toEqual([])
  })

  it('sets the documented sampling interval and detaches the debugger afterwards', async () => {
    const dbg = makeRendererDebugger()
    await captureRendererPerfDump({
      getRendererWebContents: () => makeRenderer(dbg) as never
    })

    expect(dbg.sendCommand).toHaveBeenCalledWith('Profiler.setSamplingInterval', {
      interval: 1000
    })
    expect(dbg.sendCommand).toHaveBeenCalledWith('Profiler.disable')
    expect(dbg.detach).toHaveBeenCalledTimes(1)
    expect(inspectorPostMock).toHaveBeenCalledWith(
      'Profiler.setSamplingInterval',
      { interval: 1000 },
      expect.any(Function)
    )
  })

  it('returns canceled without touching the profilers when consent is declined', async () => {
    showMessageBoxMock.mockResolvedValue({ response: 1 })
    const dbg = makeRendererDebugger()

    const result = await captureRendererPerfDump({
      getRendererWebContents: () => makeRenderer(dbg) as never
    })

    expect(result).toEqual({ canceled: true })
    expect(dbg.sendCommand).not.toHaveBeenCalled()
    expect(inspectorPostMock).not.toHaveBeenCalled()
  })

  it('coalesces concurrent captures onto one consent dialog and wires both progress listeners', async () => {
    const renderer = makeRenderer()
    const firstStages: string[] = []
    const secondStages: string[] = []
    const [first, second] = await Promise.all([
      captureRendererPerfDump({
        getRendererWebContents: () => renderer as never,
        onProgress: (stage) => firstStages.push(stage)
      }),
      captureRendererPerfDump({
        getRendererWebContents: () => renderer as never,
        onProgress: (stage) => secondStages.push(stage)
      })
    ])

    expect(showMessageBoxMock).toHaveBeenCalledTimes(1)
    expect(first).toEqual(second)
    expect(firstStages).toEqual(['metrics', 'profile', 'compressing'])
    expect(secondStages).toEqual(firstStages)
  })

  it('times out a hung renderer profiler instead of wedging the capture, then recovers', async () => {
    const dbg = makeRendererDebugger({
      sendCommand: vi.fn((method: string) =>
        method === 'Profiler.start' ? new Promise(() => {}) : Promise.resolve(undefined)
      )
    })

    const result = await captureRendererPerfDump({
      getRendererWebContents: () => makeRenderer(dbg) as never,
      profileCaptureTimeoutMs: 50
    })

    const { filePath } = result as { filePath: string }
    const entries = readTarEntries(await readFile(filePath))
    expect([...entries.keys()]).toEqual([
      'metadata.json',
      'renderer-perf-metrics.json',
      'main.cpuprofile'
    ])
    const metadata = JSON.parse(entries.get('metadata.json')!) as {
      artifacts: Record<string, { status: string; reason?: string }>
    }
    expect(metadata.artifacts.renderer_profile.status).toBe('failed')
    expect(metadata.artifacts.renderer_profile.reason).toBe('timed out')
    expect(metadata.artifacts.main_profile.status).toBe('included')

    // The single-flight latch must clear so the next capture starts fresh.
    const next = await captureRendererPerfDump({
      getRendererWebContents: () => makeRenderer() as never
    })
    expect(next).not.toHaveProperty('canceled')
    expect(showMessageBoxMock).toHaveBeenCalledTimes(2)
  })

  it('contains a debugger attach failure to a renderer_profile failure note', async () => {
    const dbg = makeRendererDebugger({
      attach: vi.fn(() => {
        throw new Error('Another debugger is already attached')
      })
    })

    const result = await captureRendererPerfDump({
      getRendererWebContents: () => makeRenderer(dbg) as never
    })

    const { filePath } = result as { filePath: string }
    const entries = readTarEntries(await readFile(filePath))
    const metadata = JSON.parse(entries.get('metadata.json')!) as {
      artifacts: Record<string, { status: string; reason?: string }>
    }
    expect(metadata.artifacts.renderer_profile.status).toBe('failed')
    expect(metadata.artifacts.renderer_profile.reason).toContain('already attached')
    expect(metadata.artifacts.main_profile.status).toBe('included')
  })

  it('survives the renderer being destroyed mid-capture', async () => {
    let destroyed = false
    const dbg = makeRendererDebugger({
      sendCommand: vi.fn(async (method: string) => {
        if (method === 'Profiler.stop') {
          destroyed = true
          throw new Error('Render frame was disposed')
        }
        return undefined
      })
    })
    const renderer = { isDestroyed: () => destroyed, debugger: dbg }

    const result = await captureRendererPerfDump({
      getRendererWebContents: () => renderer as never
    })

    const { filePath } = result as { filePath: string }
    const entries = readTarEntries(await readFile(filePath))
    const metadata = JSON.parse(entries.get('metadata.json')!) as {
      artifacts: Record<string, { status: string }>
    }
    expect(metadata.artifacts.renderer_profile.status).toBe('failed')
    expect(metadata.artifacts.main_profile.status).toBe('included')
    // Destroyed renderer: Profiler.disable must not be sent post-destruction.
    expect(dbg.sendCommand).not.toHaveBeenCalledWith('Profiler.disable')
  })

  it('still produces a report with failure notes when both profilers fail', async () => {
    const dbg = makeRendererDebugger({
      sendCommand: vi.fn(async (method: string) => {
        if (method === 'Profiler.start') {
          throw new Error('renderer profiler busy')
        }
        return undefined
      })
    })
    stubInspectorPost((method) => {
      if (method === 'Profiler.enable') {
        throw new Error('inspector unavailable')
      }
      return undefined
    })

    const result = await captureRendererPerfDump({
      getRendererWebContents: () => makeRenderer(dbg) as never
    })

    const { filePath } = result as { filePath: string }
    const entries = readTarEntries(await readFile(filePath))
    expect([...entries.keys()]).toEqual(['metadata.json', 'renderer-perf-metrics.json'])
    const metadata = JSON.parse(entries.get('metadata.json')!) as {
      artifacts: Record<string, { status: string; reason?: string }>
    }
    expect(metadata.artifacts.renderer_profile.status).toBe('failed')
    expect(metadata.artifacts.renderer_profile.reason).toContain('renderer profiler busy')
    expect(metadata.artifacts.main_profile.status).toBe('failed')
    expect(metadata.artifacts.main_profile.reason).toContain('inspector unavailable')
  })

  it('keeps the main profile when the renderer profile fails', async () => {
    const dbg = makeRendererDebugger({
      sendCommand: vi.fn(async (method: string) => {
        if (method === 'Profiler.stop') {
          throw new Error('renderer gone')
        }
        return undefined
      })
    })

    const result = await captureRendererPerfDump({
      getRendererWebContents: () => makeRenderer(dbg) as never
    })

    const { filePath } = result as { filePath: string }
    const entries = readTarEntries(await readFile(filePath))
    expect([...entries.keys()]).toEqual([
      'metadata.json',
      'renderer-perf-metrics.json',
      'main.cpuprofile'
    ])
    const metadata = JSON.parse(entries.get('metadata.json')!) as {
      artifacts: Record<string, { status: string }>
    }
    expect(metadata.artifacts.renderer_profile.status).toBe('failed')
    expect(metadata.artifacts.main_profile.status).toBe('included')
  })

  it('omits the renderer profile when no renderer is available', async () => {
    const result = await captureRendererPerfDump({
      getRendererWebContents: () => null
    })

    const { filePath } = result as { filePath: string }
    const entries = readTarEntries(await readFile(filePath))
    expect([...entries.keys()]).toContain('main.cpuprofile')
    const metadata = JSON.parse(entries.get('metadata.json')!) as {
      artifacts: Record<string, { status: string; reason?: string }>
    }
    expect(metadata.artifacts.renderer_profile.status).toBe('omitted')
    expect(metadata.artifacts.renderer_profile.reason).toBe('renderer unavailable')
  })

  it('reports progress stages in order', async () => {
    const stages: string[] = []
    await captureRendererPerfDump({
      getRendererWebContents: () => makeRenderer() as never,
      onProgress: (stage) => stages.push(stage)
    })
    expect(stages).toEqual(['metrics', 'profile', 'compressing'])
  })
})

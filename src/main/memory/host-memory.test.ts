import { beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'

const { runProcessMock, readFileMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  readFileMock: vi.fn()
}))

vi.mock('@orca/process-host', () => ({
  runProcess: runProcessMock
}))

vi.mock('node:fs/promises', () => ({
  readFile: (file: string, encoding: string) => readFileMock(file, encoding)
}))

async function loadHostMemory() {
  vi.resetModules()
  return import('./host-memory')
}

describe('host memory', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    runProcessMock.mockReset()
    readFileMock.mockReset()
    vi.spyOn(os, 'totalmem').mockReturnValue(1_000)
    vi.spyOn(os, 'freemem').mockReturnValue(100)
    vi.spyOn(os, 'cpus').mockReturnValue([{}, {}] as ReturnType<typeof os.cpus>)
    vi.spyOn(os, 'loadavg').mockReturnValue([1.5, 1, 0.5])
  })

  it('reports occupied macOS RAM even when kernel pressure is low', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin')
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: 'System-wide memory free percentage: 79%',
      stderr: '',
      timedOut: false
    })
    const { collectHostMemory } = await loadHostMemory()

    const host = await collectHostMemory()

    expect(host).toMatchObject({
      totalMemory: 1_000,
      freeMemory: 100,
      availableMemory: 100,
      availableMemorySource: 'free-memory',
      usedMemory: 900,
      memoryUsagePercent: 90,
      cpuCoreCount: 2,
      loadAverage1m: 1.5
    })
  })

  it('uses Linux MemAvailable and keeps the value within physical RAM', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux')
    vi.spyOn(os, 'totalmem').mockReturnValue(4 * 1024 * 1024)
    vi.spyOn(os, 'freemem').mockReturnValue(512 * 1024)
    readFileMock.mockResolvedValue('MemTotal: 4096 kB\nMemAvailable: 2048 kB\n')
    const { collectHostMemory } = await loadHostMemory()

    const host = await collectHostMemory()

    expect(host).toMatchObject({
      availableMemory: 2 * 1024 * 1024,
      availableMemorySource: 'proc-meminfo',
      usedMemory: 2 * 1024 * 1024,
      memoryUsagePercent: 50
    })
  })

  it('uses the bounded Node value on Windows', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    const { collectHostMemory } = await loadHostMemory()

    const host = await collectHostMemory()

    expect(host.availableMemory).toBe(100)
    expect(host.availableMemorySource).toBe('free-memory')
    expect(runProcessMock).not.toHaveBeenCalled()
    expect(readFileMock).not.toHaveBeenCalled()
  })
})

describe('host availability parsers', () => {
  it('parses Linux MemAvailable in KiB', async () => {
    const { parseLinuxAvailableMemory } = await loadHostMemory()

    expect(parseLinuxAvailableMemory('MemAvailable:    1234 kB\n')).toBe(1234 * 1024)
    expect(parseLinuxAvailableMemory('MemFree: 1234 kB\n')).toBeNull()
  })
})

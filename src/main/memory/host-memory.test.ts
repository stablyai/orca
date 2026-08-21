import { beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'

const { execFileMock, readFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  readFileMock: vi.fn()
}))

vi.mock('node:child_process', () => ({
  execFile: (
    file: string,
    args: string[],
    options: unknown,
    callback: (error: Error | null, stdout: string) => void
  ) => execFileMock(file, args, options, callback)
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
    execFileMock.mockReset()
    readFileMock.mockReset()
    vi.spyOn(os, 'totalmem').mockReturnValue(1_000)
    vi.spyOn(os, 'freemem').mockReturnValue(100)
    vi.spyOn(os, 'cpus').mockReturnValue([{}, {}] as ReturnType<typeof os.cpus>)
    vi.spyOn(os, 'loadavg').mockReturnValue([1.5, 1, 0.5])
  })

  it('uses macOS memory-pressure availability instead of immediate free pages', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin')
    execFileMock.mockImplementation((_file, _args, _options, callback) =>
      callback(null, 'System-wide memory free percentage: 79%')
    )
    const { collectHostMemory } = await loadHostMemory()

    const host = await collectHostMemory()

    expect(host).toMatchObject({
      totalMemory: 1_000,
      freeMemory: 100,
      availableMemory: 790,
      availableMemorySource: 'memory-pressure',
      usedMemory: 210,
      memoryUsagePercent: 21,
      cpuCoreCount: 2,
      loadAverage1m: 1.5
    })
    expect(execFileMock.mock.calls[0][0]).toBe('/usr/bin/memory_pressure')
    expect(execFileMock.mock.calls[0][1]).toEqual(['-Q'])
  })

  it('falls back once when macOS availability cannot be read', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin')
    execFileMock.mockImplementation((_file, _args, _options, callback) =>
      callback(new Error('unsupported'), '')
    )
    const { collectHostMemory } = await loadHostMemory()

    const first = await collectHostMemory()
    const second = await collectHostMemory()

    expect(first).toMatchObject({
      availableMemory: 100,
      availableMemorySource: 'free-memory',
      usedMemory: 900,
      memoryUsagePercent: 90
    })
    expect(second.availableMemorySource).toBe('free-memory')
    expect(execFileMock).toHaveBeenCalledTimes(1)
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
    expect(execFileMock).not.toHaveBeenCalled()
    expect(readFileMock).not.toHaveBeenCalled()
  })
})

describe('host availability parsers', () => {
  it('parses bounded macOS percentages', async () => {
    const { parseDarwinAvailableMemory } = await loadHostMemory()

    expect(parseDarwinAvailableMemory('System-wide memory free percentage: 42%', 1_000)).toBe(420)
    expect(parseDarwinAvailableMemory('System-wide memory free percentage: 101%', 1_000)).toBeNull()
  })

  it('parses Linux MemAvailable in KiB', async () => {
    const { parseLinuxAvailableMemory } = await loadHostMemory()

    expect(parseLinuxAvailableMemory('MemAvailable:    1234 kB\n')).toBe(1234 * 1024)
    expect(parseLinuxAvailableMemory('MemFree: 1234 kB\n')).toBeNull()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { openDirectory, statFile, accessFile } = vi.hoisted(() => ({
  openDirectory: vi.fn(),
  statFile: vi.fn(),
  accessFile: vi.fn()
}))
vi.mock('node:fs/promises', () => ({
  opendir: openDirectory,
  stat: statFile,
  access: accessFile,
  constants: { X_OK: 1 }
}))

// Keep listing-policy tests local; the worker suite exercises the real Dirent boundary.
vi.mock('./command-path-directory-worker-client', async () => ({
  readDetectionDirectoryViaWorker: (await import('./command-path-directory')).readDetectionDirectory
}))

import { findCommandsOnLocalPath } from './command-path-resolver'

const inventory = Array.from({ length: 30 }, (_, i) => `agent-${i}`)
const options = { platform: 'linux' as const, env: { PATH: '/front:/back' } }

function directory(names: readonly string[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const name of names) {
        yield { name }
      }
    }
  }
}

function executableFiles(files: ReadonlySet<string>): void {
  statFile.mockImplementation(async (candidate: string) => {
    if (!files.has(candidate)) {
      throw new Error('not found')
    }
    return { isFile: () => true, isDirectory: () => false }
  })
}

describe('bounded PATH detection', () => {
  beforeEach(() => {
    openDirectory.mockReset()
    statFile.mockReset()
    accessFile.mockReset().mockResolvedValue(undefined)
    executableFiles(new Set())
  })

  it('returns early-directory hits without waiting on a concurrent trailing listing', async () => {
    const slow = Promise.withResolvers<ReturnType<typeof directory>>()
    executableFiles(new Set(inventory.map((command) => `/front/${command}`)))
    openDirectory.mockImplementation(async (dir: string) => {
      return dir === '/front' ? directory(inventory) : slow.promise
    })
    const result = findCommandsOnLocalPath(inventory, options)
    try {
      await expect(
        Promise.race([result, new Promise<void>((resolve) => setImmediate(resolve))])
      ).resolves.toEqual(new Set(inventory))
    } finally {
      slow.resolve(directory([]))
      await result
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  })

  it.each([
    { label: 'large inventory', commands: inventory },
    { label: 'small inventory', commands: ['qodercli', 'qoder'] }
  ])(
    'returns later-directory hits before a held first scan resolves ($label)',
    async ({ commands }) => {
      const slowListing = Promise.withResolvers<ReturnType<typeof directory>>()
      const slowProbe = Promise.withResolvers<void>()
      executableFiles(new Set(commands.map((command) => `/back/${command}`)))
      const statExecutable = statFile.getMockImplementation()
      statFile.mockImplementation(async (candidate: string) => {
        if (candidate.startsWith('/front/')) {
          await slowProbe.promise
        }
        return statExecutable?.(candidate)
      })
      openDirectory.mockImplementation(async (dir: string) => {
        return dir === '/front' ? slowListing.promise : directory(commands)
      })
      const result = findCommandsOnLocalPath(commands, options)
      try {
        await expect(
          Promise.race([result, new Promise<void>((resolve) => setImmediate(resolve))])
        ).resolves.toEqual(new Set(commands))
      } finally {
        slowListing.resolve(directory([]))
        slowProbe.resolve()
        await result
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
  )

  it.each([
    { label: 'large inventory', commands: inventory, limit: 4 },
    { label: 'small inventory', commands: ['qodercli', 'qoder'], limit: 2 }
  ])(
    'bounds active directory scans while reaching queued hits ($label)',
    async ({ commands, limit }) => {
      const dirs = Array.from({ length: 9 }, (_, i) => `/bin-${i}`)
      const gates = new Map(dirs.map((dir) => [dir, Promise.withResolvers<void>()]))
      const active = new Set<string>()
      let peak = 0
      const hold = async (dir: string) => {
        active.add(dir)
        peak = Math.max(peak, active.size)
        await gates.get(dir)?.promise
        active.delete(dir)
      }
      openDirectory.mockImplementation(async (dir: string) => {
        await hold(dir)
        return directory(dir === '/bin-8' ? commands : [])
      })
      executableFiles(new Set(commands.map((command) => `/bin-8/${command}`)))
      const statExecutable = statFile.getMockImplementation()
      statFile.mockImplementation(async (candidate: string) => {
        await hold(candidate.slice(0, candidate.lastIndexOf('/')))
        return statExecutable?.(candidate)
      })
      const result = findCommandsOnLocalPath(commands, {
        ...options,
        env: { PATH: dirs.join(':') }
      })
      try {
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(active.size).toBeGreaterThan(0)
        expect(active.size).toBeLessThanOrEqual(limit)
        gates.get('/bin-0')?.resolve()
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(active.size).toBeLessThanOrEqual(limit)
      } finally {
        for (const gate of gates.values()) {
          gate.resolve()
        }
        await result
      }
      expect(await result).toEqual(new Set(commands))
      expect(peak).toBeLessThanOrEqual(limit)
    }
  )

  it('uses direct probes for the two-command Qoder launch without listing directories', async () => {
    executableFiles(new Set(['/front/qodercli', '/front/qoder']))
    await expect(findCommandsOnLocalPath(['qodercli', 'qoder'], options)).resolves.toEqual(
      new Set(['qodercli', 'qoder'])
    )
    expect(openDirectory).not.toHaveBeenCalled()
  })

  it('batches many misses with one listing per unique directory and no candidate stats', async () => {
    openDirectory.mockImplementation(async () => directory(['unrelated']))
    await expect(
      findCommandsOnLocalPath(inventory, {
        ...options,
        env: { PATH: '/front:/back:/front' }
      })
    ).resolves.toEqual(new Set())
    expect(openDirectory).toHaveBeenCalledTimes(2)
    expect(statFile).not.toHaveBeenCalled()
  })

  it('closes a large listing early and still probes commands beyond its scanned prefix', async () => {
    let scanned = 0
    let closed = false
    openDirectory.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        try {
          for (let i = 0; i < 30_000; i++) {
            scanned++
            yield { name: `unrelated-${i}` }
          }
        } finally {
          closed = true
        }
      }
    })
    executableFiles(new Set(['/front/agent-29']))
    await expect(
      findCommandsOnLocalPath(inventory, { ...options, env: { PATH: '/front' } })
    ).resolves.toEqual(new Set(['agent-29']))
    expect(scanned).toBeLessThan(256)
    expect(closed).toBe(true)
    expect(statFile).toHaveBeenCalledTimes(inventory.length)
  })

  it('closes a Unicode listing early and lets candidate stats decide filename equivalence', async () => {
    let scanned = 0
    let closed = false
    openDirectory.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        try {
          for (const name of ['cruſh', ...inventory]) {
            scanned++
            yield { name }
          }
        } finally {
          closed = true
        }
      }
    })
    executableFiles(new Set(['/front/crush']))
    await expect(
      findCommandsOnLocalPath(['crush', ...inventory], {
        ...options,
        env: { PATH: '/front' }
      })
    ).resolves.toEqual(new Set(['crush']))
    expect(scanned).toBe(1)
    expect(closed).toBe(true)
  })

  it.each([true, false])(
    'delegates folded POSIX matches to volume case semantics (%s)',
    async (caseSensitive) => {
      openDirectory.mockImplementation(async () => directory(['AgEnT-0']))
      executableFiles(new Set(caseSensitive ? ['/front/AgEnT-0'] : ['/front/agent-0']))
      await expect(
        findCommandsOnLocalPath(inventory, { ...options, env: { PATH: '/front' } })
      ).resolves.toEqual(new Set(caseSensitive ? [] : ['agent-0']))
      expect(statFile).toHaveBeenCalledWith('/front/agent-0')
    }
  )
})

import { expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { getManagedScriptPath, getStatusLineScriptPath } from './hook-settings'
import {
  getWindowsClaudeHookPayloadPath,
  getWindowsClaudeHookExecutablePath
} from './windows-hook-files'
import { resolveBundledWindowsNativeHookExecutable } from '../agent-hooks/windows-native-hook-executable'
import {
  seam,
  file,
  read,
  write,
  install,
  remove,
  erase,
  documentPath,
  document,
  resetService,
  applyAgentStatusHooksEnabled
} from './claude-system-statusline.test-fixture'

// Real production acquires and serializes 100/1000 physical records before measuring the bounded invocation work.
it('measures current-only System work and exact index bytes at 100 and 1000 production-acquired owners', async () => {
  const base = seam.home
  const rows: Record<string, number>[] = []
  for (const population of [100, 1000]) {
    seam.home = join(base, `N${String(population).padStart(4, '0')}`)
    await fs.mkdir(seam.home)
    vi.stubEnv('HOME', seam.home)
    vi.stubEnv('USERPROFILE', seam.home)
    await resetService()
    seam.probes = 0
    const coldStarted = performance.now()
    expect(
      (
        await applyAgentStatusHooksEnabled(true, null, {
          agents: ['claude', 'gemini'],
          env: { CLAUDE_CONFIG_DIR: dirname(file('r0000')) }
        })
      ).map((entry) => entry.state)
    ).toEqual(['installed', 'installed'])
    const coldApplyMs = performance.now() - coldStarted
    expect((await install('r0000')).state).toBe('installed')
    const coldProbes = seam.probes
    const template = await read(file('r0000'))
    const corpus = new Set([file('r0000')])
    for (let index = 1; index < population; index++) {
      const name = `r${String(index).padStart(4, '0')}`
      await write(file(name), template)
      expect((await install(name)).state).toBe('installed')
      corpus.add(file(name))
    }
    expect((await document()).destinations).toHaveLength(population)
    for (let index = 0; index < population; index++) {
      await fs.writeFile(join(seam.home, '.orca', `unrelated-${index}`), '')
    }
    const meta = await documentPath()
    const dependencyRoot = join(seam.home, '.orca', 'agent-hooks')
    const bundled =
      process.platform === 'win32' ? resolveBundledWindowsNativeHookExecutable() : null
    const dependency = (path: string) =>
      path.startsWith(`${dependencyRoot}${sep}`) || path === bundled
    const expected = new Set([getManagedScriptPath(), getStatusLineScriptPath()])
    if (process.platform === 'win32') {
      expected.add(getWindowsClaudeHookPayloadPath(getManagedScriptPath()))
      if (bundled) {
        expected.add(bundled)
        expected.add(getWindowsClaudeHookExecutablePath(getManagedScriptPath()))
      }
    }
    const measure = async (
      name: string,
      action: () => Promise<unknown>,
      verifyDependencies = false
    ) => {
      seam.calls = new Map()
      seam.bytes = new Map()
      seam.probes = 0
      let last = performance.now(),
        maxDelay = 0
      const timer = setInterval(() => {
        const now = performance.now()
        maxDelay = Math.max(maxDelay, now - last)
        last = now
      }, 1)
      const start = performance.now()
      let nextAgentMs = 0
      seam.syncAfter = (method, path) => {
        if (method === 'readFileSync' && path === join(seam.home, '.gemini/settings.json')) {
          nextAgentMs = performance.now() - start
        }
      }
      await action()
      const elapsed = performance.now() - start
      clearInterval(timer)
      const count = (method: string, accepts: (path: string) => boolean, source = seam.calls) =>
        [...source!].reduce(
          (sum, [key, n]) =>
            sum + (key.startsWith(`${method}:`) && accepts(key.slice(method.length + 1)) ? n : 0),
          0
        )
      const dependencyEntries = [...seam.calls].filter(
        ([key]) => key.startsWith('readFileSync:') && dependency(key.slice('readFileSync:'.length))
      )
      if (verifyDependencies) {
        expect(
          new Set(dependencyEntries.map(([key]) => key.slice('readFileSync:'.length)))
        ).toEqual(expected)
        expect(dependencyEntries.every(([, n]) => n === 1)).toBe(true)
      }
      const row = {
        population,
        nextAgentMs,
        elapsed,
        maxDelay,
        otherRootWork: [...seam.calls].reduce(
          (sum, [key, n]) =>
            sum +
            (['readFile', 'lstat', 'stat', 'realpath'].some(
              (method) =>
                key.startsWith(`${method}:`) &&
                [...corpus].some(
                  (path) =>
                    path !== file(name) &&
                    [path, dirname(path)].includes(key.slice(method.length + 1))
                )
            )
              ? n
              : 0),
          0
        ),
        currentReads: count('readFile', (path) => path === file(name)),
        currentReadBytes: count('readFile', (path) => path === file(name), seam.bytes),
        indexReads: count('readFile', (path) => path === meta),
        indexReadBytes: count('readFile', (path) => path === meta, seam.bytes),
        serializedBytes: count('writeFile', (path) => path.startsWith(`${meta}.`), seam.bytes),
        indexBackupBytes: count('copyFile', (path) => path.startsWith(`${meta}.bak.`), seam.bytes),
        indexWrites: count('rename', (path) => path === meta),
        settingsWrites: count('rename', (path) => path === file(name)),
        copies: count('copyFile', () => true),
        renames: count('rename', () => true),
        dependencyReads: count('readFileSync', dependency),
        dependencyBytes: count('readFileSync', dependency, seam.bytes),
        dependencyCopies: count('copyFileSync', () => true),
        dependencyRenames: count('renameSync', () => true),
        unrelatedNames: count('readdir', (path) => path === join(seam.home, '.orca')),
        lockListings: count(
          'readdir',
          (path) => path === join(dependencyRoot, 'claude-statusline', 'lock')
        ),
        probes: seam.probes
      }
      seam.calls = seam.bytes = null
      seam.syncAfter = null
      expect(row.otherRootWork).toBe(0)
      expect(row.unrelatedNames).toBe(0)
      expect(row.lockListings).toBe(1)
      expect(row.probes).toBe(0)
      expect(row.elapsed).toBeLessThan(2000)
      expect(row.maxDelay).toBeLessThan(50)
      return row
    }
    const unchanged = await fs.readFile(meta, 'utf8')
    const m = await measure('r0000', () => install('r0000'), true)
    expect(m.indexWrites).toBe(0)
    expect(m.settingsWrites).toBe(0)
    expect(m.dependencyReads).toBe(expected.size) // Fixed native-host dependencies, each verified once.
    expect(m.dependencyCopies + m.dependencyRenames).toBe(0)
    expect(await fs.readFile(meta, 'utf8')).toBe(unchanged)
    await write(file('user'), { statusLine: { type: 'command', command: '/user/owned' } })
    const u = await measure('user', () => install('user'))
    expect(u.indexReads + u.indexWrites).toBe(0)
    seam.before = async (method, path) => {
      if (
        ['readFile', 'stat', 'lstat', 'realpath'].includes(method) &&
        [...corpus].some((entry) => [entry, dirname(entry)].includes(path))
      ) {
        throw new Error('Unrelated owner is unavailable')
      }
    }
    const beforeFresh = Buffer.byteLength(await fs.readFile(meta, 'utf8'))
    const fresh = await measure('fresh', async () => {
      const results = await applyAgentStatusHooksEnabled(true, null, {
        agents: ['claude', 'gemini'],
        env: { CLAUDE_CONFIG_DIR: dirname(file('fresh')) }
      })
      expect(results.map((entry) => entry.state)).toEqual(['installed', 'installed'])
    })
    expect((await read(file('fresh'))).statusLine).toBeDefined()
    expect(fresh.nextAgentMs).toBeGreaterThan(0)
    expect(fresh.nextAgentMs).toBeLessThan(50)
    expect(fresh.indexReads).toBe(2) // Loaded authority plus the publisher's equality/backup read.
    expect(fresh.indexReadBytes).toBe(2 * beforeFresh)
    expect(fresh.indexBackupBytes).toBe(beforeFresh)
    expect(fresh.serializedBytes).toBe(Buffer.byteLength(await fs.readFile(meta, 'utf8')))
    seam.before = null
    await erase('r0000')
    const deletion = await measure('r0000', () => install('r0000'))
    expect((await read(file('r0000'))).statusLine).toBeUndefined()
    expect(deletion.indexWrites).toBe(0)
    const big = await read(file('fresh'))
    big.largeControl = 'x'.repeat(256 * 1024)
    await write(file('fresh'), big)
    const large = await measure('fresh', () => install('fresh'))
    const retire = await measure('fresh', () => install('fresh', { claudeVersion: '1.0.0' }))
    const beforeReset = Buffer.byteLength(await fs.readFile(meta, 'utf8'))
    const reset = await measure('r0000', () => remove('r0000'))
    expect(reset.indexBackupBytes).toBe(beforeReset)
    expect(reset.indexWrites).toBe(1)
    expect((await document()).destinations).toHaveLength(population - 1)
    rows.push(fresh)
    console.log(
      'SL_CURRENT_PERF',
      JSON.stringify({
        platform: process.platform,
        dependencyPaths: [...expected],
        coldProbes,
        coldApplyMs,
        settingsPathBytes: Buffer.byteLength(file('r0000')),
        m,
        u,
        fresh,
        deletion,
        large,
        retire,
        reset
      })
    )
  }
  for (const key of ['currentReads', 'indexReads', 'settingsWrites', 'probes']) {
    expect(rows[1][key]).toBe(rows[0][key])
  }
  for (const key of ['indexReadBytes', 'serializedBytes', 'indexBackupBytes']) {
    expect(rows[1][key]).toBeLessThanOrEqual(10 * rows[0][key] + 2048)
  }
  seam.home = base
}, 60_000)

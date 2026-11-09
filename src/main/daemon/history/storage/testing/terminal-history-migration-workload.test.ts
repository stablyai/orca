import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import * as asyncFs from 'node:fs/promises'
import * as recovery from '../terminal-history-recovery-quarantine'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { acquireOrcadInstanceLock } from '../../../../orcad/orcad-instance-lock'
import { HistoryManager } from '../history-manager'
import { installTerminalHistoryIdentity } from '../terminal-history-identity-install'

vi.mock('node:fs/promises', async (original) => ({ ...(await original<typeof asyncFs>()) }))
vi.mock('../terminal-history-recovery-quarantine', async (original) => ({
  ...(await original<typeof recovery>())
}))
vi.mock('../../../launch/daemon-generation-liveness', () => ({
  listLiveDaemonProtocols: async () => []
}))
afterEach(() => vi.restoreAllMocks())

it.each([3, 30])(
  'measures lossless migration and cancellation/retry progress for %i one-MiB histories',
  async (count) => {
    const dir = mkdtempSync(join(tmpdir(), 'restore-pty-workload-'))
    mkdirSync(join(dir, 'history'))
    mkdirSync(join(dir, 'runtime'))
    const lock = acquireOrcadInstanceLock(dir)
    const manager = new HistoryManager(join(dir, 'history'))
    const root = manager.identityRoot!
    await root.bindProfile(dir, join(dir, 'runtime'), () => [])
    const initial = { cwd: '/original', cols: 120, rows: 40 }
    const screen = 'actual terminal output line with saved work\r\n'.repeat(25_000)
    const sample = {
      snapshotAnsi: 'prompt',
      scrollbackAnsi: screen,
      rehydrateSequences: '',
      ...initial,
      scrollbackLines: 25_000,
      modes: {
        bracketedPaste: true,
        mouseTracking: false,
        applicationCursor: false,
        alternateScreen: false
      }
    }
    try {
      for (let index = 0; index < count; index++) {
        await manager.openSession(String(index), initial)
        expect(await manager.checkpoint(String(index), sample)).toBe('committed')
        expect(readdirSync(join(root.path, String(index))).sort()).toEqual([
          'checkpoint.json',
          'meta.json',
          'output.log'
        ])
      }
      const parse = JSON.parse
      let parseMs = 0
      const parseSpy = vi.spyOn(JSON, 'parse').mockImplementation((...args) => {
        const started = performance.now()
        try {
          return parse(...args)
        } finally {
          parseMs += performance.now() - started
        }
      })
      const fingerprint = recovery.fingerprintTerminalHistorySession
      let fingerprintMs = 0
      const fingerprintSpy = vi
        .spyOn(recovery, 'fingerprintTerminalHistorySession')
        .mockImplementation((...args) => {
          const started = performance.now()
          try {
            return fingerprint(...args)
          } finally {
            fingerprintMs += performance.now() - started
          }
        })
      const copy = asyncFs.copyFile
      const copyStarted: number[] = []
      let copyMs = 0
      const copySpy = vi.spyOn(asyncFs, 'copyFile').mockImplementation(async (...args) => {
        const started = performance.now()
        copyStarted.push(started)
        try {
          await copy(...args)
        } finally {
          copyMs += performance.now() - started
        }
      })
      const started = performance.now()
      const results = await Promise.all(
        Array.from({ length: count }, (_, index) =>
          installTerminalHistoryIdentity(root, String(index), `scope-${index}`, initial, () => true)
        )
      )
      const elapsedMs = performance.now() - started
      expect(results).toEqual(Array(count).fill('canonical'))
      for (let index = 0; index < count; index++) {
        for (const name of ['meta.json', 'checkpoint.json', 'output.log']) {
          expect(
            readFileSync(join(root.path, `scope-${index}`, name)).equals(
              readFileSync(join(root.path, String(index), name))
            )
          ).toBe(true)
        }
      }
      const copies = copyStarted.length
      // Each checkpointed source has metadata, a checkpoint and its generation log header.
      expect(copies).toBe(count * 3)
      await Promise.all(
        Array.from({ length: count }, (_, index) =>
          installTerminalHistoryIdentity(root, String(index), `scope-${index}`, initial, () => true)
        )
      )
      expect(copyStarted).toHaveLength(copies)
      copySpy.mockRestore()
      const cancel = new AbortController()
      const interrupted = vi.spyOn(asyncFs, 'copyFile').mockImplementation(async (...args) => {
        await copy(...args)
        cancel.abort()
      })
      expect(
        await installTerminalHistoryIdentity(
          root,
          '0',
          'retry-scope',
          initial,
          () => true,
          cancel.signal
        )
      ).toBe('legacy')
      interrupted.mockRestore()
      expect(readdirSync(root.path)).not.toContain('retry-scope')
      expect(
        await installTerminalHistoryIdentity(root, '0', 'retry-scope', initial, () => true)
      ).toBe('canonical')
      expect(
        readFileSync(join(root.path, 'retry-scope/checkpoint.json')).equals(
          readFileSync(join(root.path, '0/checkpoint.json'))
        )
      ).toBe(true)
      expect(readdirSync(root.path).filter((name) => name.startsWith('.identity-copy-'))).toEqual(
        []
      )
      console.info(
        JSON.stringify({
          workload: 'legacy-history-migration',
          count,
          bytesPerHistory: Buffer.byteLength(screen),
          elapsedMs,
          firstCopyWaitMs: copyStarted[0] - started,
          lastCopyWaitMs: copyStarted.at(-1)! - started,
          copyMs,
          parseMs,
          fingerprintMs,
          cancellationRetry: 'progressed'
        })
      )
      parseSpy.mockRestore()
      fingerprintSpy.mockRestore()
    } finally {
      await manager.releaseIdentity('detach')
      lock.release()
      rmSync(dir, { recursive: true, force: true })
    }
  },
  120_000
)

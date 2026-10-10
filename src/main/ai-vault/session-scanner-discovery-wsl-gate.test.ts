import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Dirent } from 'node:fs'
import type * as NodeFsPromisesModule from 'node:fs/promises'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'

const fsMocks = vi.hoisted(() => ({ readdir: vi.fn(), stat: vi.fn() }))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromisesModule>()),
  readdir: fsMocks.readdir,
  stat: fsMocks.stat
}))

import {
  resetWslTranscriptFsGateForTests,
  WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS,
  WslTranscriptFsError
} from '../native-chat/wsl-transcript-fs-gate'
import { discoverFiles, walkSessionFiles } from './session-scanner-discovery'

const SLOW_MESSAGE =
  'WSL transcript files are temporarily unavailable because filesystem access is taking too long. Try again shortly or restart Orca if the issue continues.'

// Complete: UNC readdir results pass through the child dispatcher's dirent
// serializer, which reads every kind flag.
function dirent(name: string): Dirent {
  return {
    name,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isDirectory: () => false,
    isFIFO: () => false,
    isFile: () => true,
    isSocket: () => false,
    isSymbolicLink: () => false
  } as Dirent
}

let releaseStall: (() => void) | undefined

function stalls<T>(): Promise<T> {
  return new Promise<T>((resolve) => {
    releaseStall = () => resolve(undefined as T)
  })
}

beforeEach(() => {
  resetWslTranscriptFsGateForTests()
  fsMocks.readdir.mockReset()
  fsMocks.stat.mockReset()
  fsMocks.readdir.mockResolvedValue([])
  releaseStall = undefined
})

// A stalled task holds its gate permit until the call settles; releasing it
// keeps the next case from fast-failing on an already-exhausted gate.
afterEach(async () => {
  if (!vi.isFakeTimers()) {
    return
  }
  releaseStall?.()
  await vi.advanceTimersByTimeAsync(0)
  vi.useRealTimers()
})

describe('walkSessionFiles WSL gate refusals', () => {
  it('rethrows gate refusals instead of reporting an empty tree', async () => {
    const refusal = new WslTranscriptFsError('timeout', 'slow share')
    await expect(
      walkSessionFiles('\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions', 'codex', [], {
        extensions: new Set(['.jsonl']),
        readDirectory: async () => {
          throw refusal
        }
      })
    ).rejects.toBe(refusal)
  })

  it('still treats ordinary readdir failures as an empty tree', async () => {
    await expect(
      walkSessionFiles('/missing/root', 'codex', [], {
        extensions: new Set(['.jsonl']),
        readDirectory: async () => {
          throw Object.assign(new Error('no such directory'), { code: 'ENOENT' })
        }
      })
    ).resolves.toEqual([])
  })
})

describe('discoverFiles containment for a stalled WSL root', () => {
  const UNC_ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.codex\\sessions'

  it('contains a stalled readdir to one root so a Promise.all fan-out still resolves', async () => {
    vi.useFakeTimers()
    {
      fsMocks.readdir.mockImplementation((dir: string) =>
        dir === UNC_ROOT ? stalls<Dirent[]>() : Promise.resolve([])
      )
      const issues: AiVaultScanIssue[] = []
      const discovery = discoverFiles({
        rootDir: UNC_ROOT,
        limit: 10,
        agent: 'codex',
        issues,
        extensions: ['.jsonl']
      })
      const healthy = discoverFiles({
        rootDir: '/home/ada/.codex/sessions',
        limit: 10,
        agent: 'codex',
        issues: [],
        extensions: ['.jsonl']
      })

      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS + 1)

      await expect(Promise.all([discovery, healthy])).resolves.toEqual([
        { agent: 'codex', rootDir: UNC_ROOT, files: [] },
        { agent: 'codex', rootDir: '/home/ada/.codex/sessions', files: [] }
      ])
      expect(issues).toEqual([{ agent: 'codex', path: UNC_ROOT, message: SLOW_MESSAGE }])
    }
  })

  it('reports every stalled file without spending one deadline per file', async () => {
    vi.useFakeTimers()
    {
      const names = ['a', 'b', 'c', 'd', 'e'].map((name) => dirent(`${name}.jsonl`))
      fsMocks.readdir.mockResolvedValue(names)
      fsMocks.stat.mockImplementation(stalls)
      const issues: AiVaultScanIssue[] = []
      const discovery = discoverFiles({
        rootDir: UNC_ROOT,
        limit: 10,
        agent: 'codex',
        issues,
        extensions: ['.jsonl']
      })

      // Two deadlines total, not five: once the first stalled stat is marked
      // stuck, every later file fast-fails on the route instead of queueing.
      await vi.advanceTimersByTimeAsync(WSL_TRANSCRIPT_FS_SCAN_TIMEOUT_MS * 2 + 2)

      await expect(discovery).resolves.toEqual({ agent: 'codex', rootDir: UNC_ROOT, files: [] })
      expect(issues).toHaveLength(names.length)
      expect(issues.every((issue) => issue.path.startsWith(UNC_ROOT))).toBe(true)
    }
  })
})

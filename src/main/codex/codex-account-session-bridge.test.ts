import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as sessionLinkModule from './codex-session-link'
import {
  _internals,
  bridgeCodexSessionsIntoAccountHome,
  linkCodexRolloutIntoAccountHome,
  startCodexAccountSessionBridgeInBackground
} from './codex-account-session-bridge'

let workspaceRoot: string

function writeRollout(homePath: string, relativePath: string, contents: string): string {
  const filePath = join(homePath, 'sessions', relativePath)
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, contents)
  return filePath
}

function rolloutPath(homePath: string, relativePath: string): string {
  return join(homePath, 'sessions', relativePath)
}

const ROLLOUT_A = join('2026', '07', '20', 'rollout-2026-07-20T10-00-00-aaaa.jsonl')
const ROLLOUT_B = join('2026', '07', '21', 'rollout-2026-07-21T10-00-00-bbbb.jsonl')

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'codex-account-session-bridge-'))
  _internals.resetBackgroundBridgeTasks()
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
})

describe('bridgeCodexSessionsIntoAccountHome', () => {
  it('links every source home rollout into the target account home', async () => {
    const systemHome = join(workspaceRoot, 'system')
    const otherAccountHome = join(workspaceRoot, 'account-a')
    const targetHome = join(workspaceRoot, 'account-b')
    writeRollout(systemHome, ROLLOUT_A, 'system session\n')
    writeRollout(otherAccountHome, ROLLOUT_B, 'account a session\n')

    const summary = await bridgeCodexSessionsIntoAccountHome({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [systemHome, otherAccountHome],
      options: { batchSize: 1, yieldMs: 0 }
    })

    expect(summary).toEqual({ scannedFiles: 2, linkedFiles: 2 })
    expect(readFileSync(rolloutPath(targetHome, ROLLOUT_A), 'utf-8')).toBe('system session\n')
    expect(readFileSync(rolloutPath(targetHome, ROLLOUT_B), 'utf-8')).toBe('account a session\n')
  })

  it('shares one physical log so an appended resume is visible from both homes', async () => {
    const systemHome = join(workspaceRoot, 'system')
    const targetHome = join(workspaceRoot, 'account')
    const sourcePath = writeRollout(systemHome, ROLLOUT_A, 'first\n')

    await bridgeCodexSessionsIntoAccountHome({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [systemHome]
    })

    const targetPath = rolloutPath(targetHome, ROLLOUT_A)
    // Why: hardlinks are the whole point — a resume that appends under one home
    // must not fork the conversation into two diverging logs.
    expect(statSync(targetPath).ino).toBe(statSync(sourcePath).ino)
  })

  it('bridges compressed rollouts so archived history still resumes', async () => {
    const systemHome = join(workspaceRoot, 'system')
    const targetHome = join(workspaceRoot, 'account')
    const compressed = join('2026', '07', '19', 'rollout-2026-07-19T10-00-00-cccc.jsonl.zst')
    writeRollout(systemHome, compressed, 'compressed\n')

    const summary = await bridgeCodexSessionsIntoAccountHome({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [systemHome]
    })

    expect(summary.linkedFiles).toBe(1)
    expect(readFileSync(rolloutPath(targetHome, compressed), 'utf-8')).toBe('compressed\n')
  })

  it('leaves an already-bridged rollout untouched on a later launch', async () => {
    const systemHome = join(workspaceRoot, 'system')
    const targetHome = join(workspaceRoot, 'account')
    writeRollout(systemHome, ROLLOUT_A, 'first\n')
    await bridgeCodexSessionsIntoAccountHome({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [systemHome]
    })

    const second = await bridgeCodexSessionsIntoAccountHome({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [systemHome]
    })

    expect(second).toEqual({ scannedFiles: 1, linkedFiles: 0 })
  })

  it('never links a home into itself or scans a duplicate source twice', async () => {
    const targetHome = join(workspaceRoot, 'account')
    writeRollout(targetHome, ROLLOUT_A, 'own session\n')

    const summary = await bridgeCodexSessionsIntoAccountHome({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [targetHome, targetHome]
    })

    expect(summary).toEqual({ scannedFiles: 0, linkedFiles: 0 })
  })

  it('skips a source home that has no sessions tree', async () => {
    const targetHome = join(workspaceRoot, 'account')
    const summary = await bridgeCodexSessionsIntoAccountHome({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [join(workspaceRoot, 'missing')]
    })

    expect(summary).toEqual({ scannedFiles: 0, linkedFiles: 0 })
  })
})

describe('startCodexAccountSessionBridgeInBackground', () => {
  it('shares one in-flight task per target home', () => {
    const systemHome = join(workspaceRoot, 'system')
    const targetHome = join(workspaceRoot, 'account')
    writeRollout(systemHome, ROLLOUT_A, 'session\n')

    const first = startCodexAccountSessionBridgeInBackground({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [systemHome]
    })
    const second = startCodexAccountSessionBridgeInBackground({
      targetCodexHomePath: targetHome,
      sourceCodexHomePaths: [systemHome]
    })

    expect(second).toBe(first)
    return first
  })

  it('runs separate targets independently', async () => {
    const systemHome = join(workspaceRoot, 'system')
    const firstTarget = join(workspaceRoot, 'account-a')
    const secondTarget = join(workspaceRoot, 'account-b')
    writeRollout(systemHome, ROLLOUT_A, 'session\n')

    await Promise.all([
      startCodexAccountSessionBridgeInBackground({
        targetCodexHomePath: firstTarget,
        sourceCodexHomePaths: [systemHome]
      }),
      startCodexAccountSessionBridgeInBackground({
        targetCodexHomePath: secondTarget,
        sourceCodexHomePaths: [systemHome]
      })
    ])

    expect(readFileSync(rolloutPath(firstTarget, ROLLOUT_A), 'utf-8')).toBe('session\n')
    expect(readFileSync(rolloutPath(secondTarget, ROLLOUT_A), 'utf-8')).toBe('session\n')
  })
})

describe('linkCodexRolloutIntoAccountHome', () => {
  it('places one named rollout under the target home ahead of the whole-tree sweep', () => {
    const sourceHome = join(workspaceRoot, 'account-a')
    const targetHome = join(workspaceRoot, 'account-b')
    const rolloutFilePath = writeRollout(sourceHome, ROLLOUT_A, 'session\n')

    const linkedPath = linkCodexRolloutIntoAccountHome({
      sourceCodexHomePath: sourceHome,
      targetCodexHomePath: targetHome,
      rolloutFilePath
    })

    expect(linkedPath).toBe(rolloutPath(targetHome, ROLLOUT_A))
    expect(readFileSync(rolloutPath(targetHome, ROLLOUT_A), 'utf-8')).toBe('session\n')
    expect(statSync(rolloutPath(targetHome, ROLLOUT_A)).ino).toBe(statSync(rolloutFilePath).ino)
  })

  it('reports the existing path when the sweep already linked that rollout', () => {
    const sourceHome = join(workspaceRoot, 'account-a')
    const targetHome = join(workspaceRoot, 'account-b')
    const rolloutFilePath = writeRollout(sourceHome, ROLLOUT_A, 'session\n')
    writeRollout(targetHome, ROLLOUT_A, 'session\n')

    expect(
      linkCodexRolloutIntoAccountHome({
        sourceCodexHomePath: sourceHome,
        targetCodexHomePath: targetHome,
        rolloutFilePath
      })
    ).toBe(rolloutPath(targetHome, ROLLOUT_A))
    expect(readFileSync(rolloutPath(targetHome, ROLLOUT_A), 'utf-8')).toBe('session\n')
  })

  it.each(['', 'divergent history\n', 'sess'])(
    'refuses and preserves an invalid existing copy: %j',
    (contents) => {
      const sourceHome = join(workspaceRoot, 'account-a')
      const targetHome = join(workspaceRoot, 'account-b')
      const rolloutFilePath = writeRollout(sourceHome, ROLLOUT_A, 'session\n')
      const target = writeRollout(targetHome, ROLLOUT_A, contents)
      expect(
        linkCodexRolloutIntoAccountHome({
          sourceCodexHomePath: sourceHome,
          targetCodexHomePath: targetHome,
          rolloutFilePath
        })
      ).toBeNull()
      expect(readFileSync(target, 'utf8')).toBe(contents)
      expect(readFileSync(rolloutFilePath, 'utf8')).toBe('session\n')
    }
  )

  // skipIf: symlink creation on Windows needs elevation or Developer Mode.
  it.skipIf(process.platform === 'win32')(
    'replaces a symlink the sweep left so the hardlink can still land',
    () => {
      const sourceHome = join(workspaceRoot, 'account-a')
      const targetHome = join(workspaceRoot, 'account-b')
      const rolloutFilePath = writeRollout(sourceHome, ROLLOUT_B, 'session\n')
      const targetFilePath = rolloutPath(targetHome, ROLLOUT_B)
      mkdirSync(join(targetFilePath, '..'), { recursive: true })
      symlinkSync(rolloutFilePath, targetFilePath)

      expect(
        linkCodexRolloutIntoAccountHome({
          sourceCodexHomePath: sourceHome,
          targetCodexHomePath: targetHome,
          rolloutFilePath
        })
      ).toBe(targetFilePath)
      expect(lstatSync(targetFilePath).isSymbolicLink()).toBe(false)
      expect(statSync(targetFilePath).ino).toBe(statSync(rolloutFilePath).ino)
    }
  )

  it('refuses a rollout that lies outside the source home sessions tree', () => {
    const sourceHome = join(workspaceRoot, 'account-a')
    const targetHome = join(workspaceRoot, 'account-b')
    const strayPath = join(workspaceRoot, 'elsewhere', 'rollout-2026-07-20T10-00-00-aaaa.jsonl')
    mkdirSync(join(strayPath, '..'), { recursive: true })
    writeFileSync(strayPath, 'session\n')

    expect(
      linkCodexRolloutIntoAccountHome({
        sourceCodexHomePath: sourceHome,
        targetCodexHomePath: targetHome,
        rolloutFilePath: strayPath
      })
    ).toBeNull()
  })

  it('falls back to copying the rollout file when hardlink fails (e.g. cross-volume EXDEV on Windows)', () => {
    const sourceHome = join(workspaceRoot, 'account-a')
    const targetHome = join(workspaceRoot, 'account-b')
    const rolloutFilePath = writeRollout(sourceHome, ROLLOUT_B, 'copied session content\n')
    const targetFilePath = rolloutPath(targetHome, ROLLOUT_B)

    const hardlinkSpy = vi
      .spyOn(sessionLinkModule, 'tryHardlinkCodexSessionFile')
      .mockReturnValue(false)
    try {
      const linkedPath = linkCodexRolloutIntoAccountHome({
        sourceCodexHomePath: sourceHome,
        targetCodexHomePath: targetHome,
        rolloutFilePath
      })

      expect(linkedPath).toBe(targetFilePath)
      expect(readFileSync(targetFilePath, 'utf-8')).toBe('copied session content\n')
      expect(lstatSync(targetFilePath).isFile()).toBe(true)
      expect(lstatSync(targetFilePath).isSymbolicLink()).toBe(false)
    } finally {
      hardlinkSpy.mockRestore()
    }
  })

  it('handles Windows extended path prefix (\\\\?\\) in paths properly', () => {
    const sourceHome = join(workspaceRoot, 'account-a')
    const targetHome = join(workspaceRoot, 'account-b')
    const rolloutFilePath = writeRollout(sourceHome, ROLLOUT_A, 'session-extended\n')
    const targetFilePath = rolloutPath(targetHome, ROLLOUT_A)

    const extendedRolloutPath = `\\\\?\\${rolloutFilePath}`
    const extendedSourceHome = `\\\\?\\${sourceHome}`
    const linkedPath = linkCodexRolloutIntoAccountHome({
      sourceCodexHomePath: extendedSourceHome,
      targetCodexHomePath: targetHome,
      rolloutFilePath: extendedRolloutPath
    })

    expect(linkedPath).toBe(targetFilePath)
    expect(readFileSync(targetFilePath, 'utf-8')).toBe('session-extended\n')
  })

  it('does not copy over a racing background sweep rollout if hardlink fails', () => {
    const sourceHome = join(workspaceRoot, 'account-a')
    const targetHome = join(workspaceRoot, 'account-b')
    const rolloutFilePath = writeRollout(sourceHome, ROLLOUT_B, 'original session\n')
    const targetFilePath = rolloutPath(targetHome, ROLLOUT_B)

    // Simulate racing background sweep placing the file right before copy attempt
    const copySpy = vi.spyOn(sessionLinkModule, 'tryCopyCodexSessionFile')
    const hardlinkSpy = vi
      .spyOn(sessionLinkModule, 'tryHardlinkCodexSessionFile')
      .mockImplementation(() => {
        // Background sweep placed the file!
        writeRollout(targetHome, ROLLOUT_B, 'original session\n')
        return false
      })

    try {
      const linkedPath = linkCodexRolloutIntoAccountHome({
        sourceCodexHomePath: sourceHome,
        targetCodexHomePath: targetHome,
        rolloutFilePath
      })

      expect(linkedPath).toBe(targetFilePath)
      expect(readFileSync(targetFilePath, 'utf-8')).toBe('original session\n')
      expect(copySpy).not.toHaveBeenCalled()
    } finally {
      hardlinkSpy.mockRestore()
      copySpy.mockRestore()
    }
  })
})

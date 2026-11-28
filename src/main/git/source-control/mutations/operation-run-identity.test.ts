import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { abortMerge } from './git-conflict-operation'
import {
  assertOperationRunIdentity,
  markerIdentity,
  readOperationRunIdentity,
  readStableRunIdentity
} from './operation-run-identity'

describe('operation run identity', () => {
  const tempPaths: string[] = []

  afterEach(() => {
    for (const path of tempPaths.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  /** main and other both edit app.txt, so `git merge other` stops on a conflict at the same HEAD each time. */
  function createConflictingMerge() {
    const repoPath = mkdtempSync(join(tmpdir(), 'orca-operation-run-identity-'))
    tempPaths.push(repoPath)
    const git = (...args: string[]): string => {
      try {
        return execFileSync('git', args, {
          cwd: repoPath,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch (error) {
        // A conflicted merge exits non-zero by design.
        if (args[0] === 'merge') {
          return ''
        }
        throw error
      }
    }
    const write = (text: string) => writeFileSync(join(repoPath, 'app.txt'), text)
    git('init', '--quiet', '-b', 'main')
    git('config', 'user.name', 'Orca Test')
    git('config', 'user.email', 'orca@example.test')
    git('config', 'commit.gpgSign', 'false')
    git('config', 'core.hooksPath', '.git/no-hooks')
    write('base\n')
    git('add', '.')
    git('commit', '--quiet', '-m', 'base')
    git('checkout', '--quiet', '-b', 'other')
    write('other\n')
    git('commit', '--quiet', '-am', 'other')
    git('checkout', '--quiet', 'main')
    write('main\n')
    git('commit', '--quiet', '-am', 'main')
    const startMerge = () => git('merge', 'other')
    return { repoPath, git, startMerge }
  }

  it('gives a restarted merge at the same HEAD a new identity, so an earlier confirm cannot abort it', async () => {
    const { repoPath, git, startMerge } = createConflictingMerge()
    startMerge()
    const head = git('rev-parse', 'HEAD').trim()
    const armed = await readOperationRunIdentity(repoPath, 'merge')
    expect(armed).toMatch(/^MERGE_HEAD:/)
    await expect(assertOperationRunIdentity(repoPath, 'merge', armed!)).resolves.toBeUndefined()

    // The run the user armed Abort against ends, and a new merge of the same branch begins.
    git('merge', '--abort')
    startMerge()
    expect(git('rev-parse', 'HEAD').trim()).toBe(head)
    expect(await readOperationRunIdentity(repoPath, 'merge')).not.toBe(armed)

    await expect(abortMerge(repoPath, {}, { expectedRunIdentity: armed! })).rejects.toThrow(
      /changed after Abort was chosen/
    )
    // Refused, so the new run is still paused.
    expect(await readOperationRunIdentity(repoPath, 'merge')).not.toBeNull()

    const current = await readOperationRunIdentity(repoPath, 'merge')
    await abortMerge(repoPath, {}, { expectedRunIdentity: current! })
    expect(await readOperationRunIdentity(repoPath, 'merge')).toBeNull()

    // Fails closed: once the run it was bound to is gone, a confirmation can't abort anything.
    await expect(assertOperationRunIdentity(repoPath, 'merge', current!)).rejects.toThrow(
      /changed after Abort was chosen/
    )
  })

  it('treats a reading with no birth time and whole-second times as unreadable', () => {
    const second = 1_700_000_000n * 1_000_000_000n
    const weak = { ino: 42n, birthtimeNs: 0n, ctimeNs: second, mtimeNs: second }
    expect(markerIdentity('MERGE_HEAD', weak)).toBeNull()
    // Sub-second times or a birth time make it usable again.
    expect(markerIdentity('MERGE_HEAD', { ...weak, mtimeNs: second + 7n })).not.toBeNull()
    expect(markerIdentity('MERGE_HEAD', { ...weak, birthtimeNs: second })).not.toBeNull()
    // A reused inode with fresh times still reads as a different run.
    const first = { ino: 42n, birthtimeNs: second, ctimeNs: second + 1n, mtimeNs: second + 1n }
    const reused = { ...first, ctimeNs: second + 9n, mtimeNs: second + 9n }
    expect(markerIdentity('MERGE_HEAD', reused)).not.toBe(markerIdentity('MERGE_HEAD', first))
  })

  it('drops a status reading when the run changed while the status was taken', async () => {
    // The re-read after the porcelain read sees run B where the first reading saw run A.
    await expect(readStableRunIdentity('A', async () => 'B')).resolves.toBeNull()
    await expect(readStableRunIdentity('A', async () => null)).resolves.toBeNull()
    await expect(
      readStableRunIdentity('A', async () => {
        throw new Error('stat failed')
      })
    ).resolves.toBeNull()
    await expect(readStableRunIdentity('A', async () => 'A')).resolves.toBe('A')
    await expect(readStableRunIdentity(null, async () => 'A')).resolves.toBeNull()
  })
})

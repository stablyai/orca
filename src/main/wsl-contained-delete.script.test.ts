import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '../shared/child-process/run-process'
import { containedDeleteCommand } from './wsl-contained-delete'

const DISTRO = 'Ubuntu'

function parseLinuxAsWsl(path: string): { distro: string; linuxPath: string } | null {
  return path.startsWith('/') ? { distro: DISTRO, linuxPath: path } : null
}

// Script walks /proc/self/cwd and GNU stat -Lc; macOS has neither.
describe.skipIf(process.platform !== 'linux')('WSL contained-delete script under sh', () => {
  let fixtureRoot = ''

  afterEach(() => {
    if (fixtureRoot === '') {
      return
    }
    const tmpRoot = realpathSync(tmpdir())
    if (fixtureRoot === tmpRoot || !fixtureRoot.startsWith(`${tmpRoot}/`)) {
      throw new Error(`refusing to clean unexpected fixture ${fixtureRoot}`)
    }
    rmSync(fixtureRoot, { recursive: true, force: true })
    fixtureRoot = ''
  })

  function makeFixture(): { approvedRoot: string; outsideRoot: string } {
    fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), 'orca-wsl-contained-delete-')))
    const approvedRoot = join(fixtureRoot, 'root')
    const outsideRoot = join(fixtureRoot, 'outside')
    mkdirSync(approvedRoot)
    mkdirSync(outsideRoot)
    return { approvedRoot, outsideRoot }
  }

  async function runContainedDelete(targetPath: string, approvedRoot: string, recursive: boolean) {
    const command = containedDeleteCommand(
      { distro: DISTRO, linuxPath: targetPath },
      [approvedRoot],
      parseLinuxAsWsl,
      recursive
    )
    expect(command).not.toBeNull()
    const [program, ...args] = command ?? []
    expect(program).toBe('sh')
    return runProcess({ program, args, timeoutMs: 10_000 })
  }

  it('deletes an approved directory leaf', async () => {
    const { approvedRoot, outsideRoot } = makeFixture()
    const leaf = join(approvedRoot, 'a', 'b')
    mkdirSync(leaf, { recursive: true })
    writeFileSync(join(leaf, 'file.txt'), 'inside')
    const survivor = join(outsideRoot, 'survivor')
    writeFileSync(survivor, 'keep')

    const result = await runContainedDelete(leaf, approvedRoot, true)

    expect(result.timedOut).toBe(false)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(existsSync(leaf)).toBe(false)
    expect(existsSync(join(approvedRoot, 'a'))).toBe(true)
    expect(existsSync(survivor)).toBe(true)
  })

  it('rejects a file when the expected kind is directory', async () => {
    const { approvedRoot } = makeFixture()
    const leaf = join(approvedRoot, 'a', 'leaf')
    mkdirSync(join(approvedRoot, 'a'), { recursive: true })
    writeFileSync(leaf, 'file')

    const result = await runContainedDelete(leaf, approvedRoot, true)

    expect(result.timedOut).toBe(false)
    expect(result.code).toBe(65)
    expect(result.stderr).toContain('ORCA_WSL_DELETE_REJECT:kind')
    expect(existsSync(leaf)).toBe(true)
  })

  it('rejects a symlink that escapes the approved root', async () => {
    const { approvedRoot, outsideRoot } = makeFixture()
    const outsideLeaf = join(outsideRoot, 'b')
    mkdirSync(outsideLeaf, { recursive: true })
    writeFileSync(join(outsideLeaf, 'secret'), 'protected')
    symlinkSync(outsideRoot, join(approvedRoot, 'a'))

    const result = await runContainedDelete(join(approvedRoot, 'a', 'b'), approvedRoot, true)

    expect(result.timedOut).toBe(false)
    expect(result.code).toBe(65)
    expect(result.stderr).toContain('ORCA_WSL_DELETE_REJECT:symlink')
    expect(existsSync(outsideLeaf)).toBe(true)
    expect(existsSync(join(outsideLeaf, 'secret'))).toBe(true)
  })

  it('is a no-op when the leaf is already missing', async () => {
    const { approvedRoot } = makeFixture()
    mkdirSync(join(approvedRoot, 'a'), { recursive: true })
    const missing = join(approvedRoot, 'a', 'gone')

    const result = await runContainedDelete(missing, approvedRoot, true)

    expect(result.timedOut).toBe(false)
    expect(result.code).toBe(0)
    expect(existsSync(join(approvedRoot, 'a'))).toBe(true)
    expect(existsSync(missing)).toBe(false)
  })
})

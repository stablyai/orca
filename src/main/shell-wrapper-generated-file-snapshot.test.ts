/**
 * Byte-for-byte snapshots of every shell wrapper file Orca generates, for all
 * three transports (local PTY, daemon/SSH, relay overlay).
 *
 * Why: the zsh generators were unified behind one builder; these fixtures were
 * captured from the pre-unification code so any drift shows up as a diff.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureShellReadyWrappersAt } from './providers/local-pty-shell-ready-wrapper-generation'
import { getShellReadyLaunchConfig as getDaemonShellReadyLaunchConfig } from './daemon/shell-ready'
import { ensureOverlayRestoreWrappers } from '../relay/pty-shell-overlay-wrappers'
import { getShellReadyLaunchConfig as getLocalShellReadyLaunchConfig } from './providers/local-pty-shell-ready'

const WRAPPER_FILES = [
  ['zsh-zshenv', join('zsh', '.zshenv')],
  ['zsh-zprofile', join('zsh', '.zprofile')],
  ['zsh-zshrc', join('zsh', '.zshrc')],
  ['zsh-zlogin', join('zsh', '.zlogin')],
  ['bash-rcfile', join('bash', 'rcfile')]
] as const

const SNAPSHOT_DIR = join(__dirname, 'shell-wrapper-snapshots')

// Why: the wrapper root is a temp dir per run, and the baked ZDOTDIR literal is
// the only path-dependent byte in the output; pin it to a stable placeholder.
function withStableRoot(content: string, root: string): string {
  return content.split(root).join('<WRAPPER_ROOT>')
}

function snapshotPath(transport: string, label: string): string {
  return join(SNAPSHOT_DIR, `${transport}-${label}.txt`)
}

async function expectWrapperFiles(transport: string, root: string): Promise<void> {
  for (const [label, relativePath] of WRAPPER_FILES) {
    const content = readFileSync(join(root, relativePath), 'utf8')
    await expect(withStableRoot(content, root)).toMatchFileSnapshot(snapshotPath(transport, label))
  }
}

// Why: all three generators are POSIX-only (the launch configs skip wrapping on
// win32), and native Windows path separators would make the fixtures unstable.
const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('generated shell wrapper files', () => {
  let root = ''
  let previousUserDataPath: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-wrapper-snapshot-'))
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  })

  afterEach(() => {
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
    rmSync(root, { recursive: true, force: true })
  })

  it('local PTY wrappers', async () => {
    ensureShellReadyWrappersAt(root)
    await expectWrapperFiles('local', root)
  })

  it('daemon wrappers', async () => {
    process.env.ORCA_USER_DATA_PATH = root
    getDaemonShellReadyLaunchConfig('/bin/zsh')
    await expectWrapperFiles('daemon', join(root, 'shell-ready'))
  })

  it('relay overlay wrappers', async () => {
    ensureOverlayRestoreWrappers(root)
    await expectWrapperFiles('relay', root)
  })

  it('fish shell-ready init commands', async () => {
    process.env.ORCA_USER_DATA_PATH = root
    const local = getLocalShellReadyLaunchConfig('/usr/bin/fish')
    const daemon = getDaemonShellReadyLaunchConfig('/usr/bin/fish')
    await expect(local.args?.[2]).toMatchFileSnapshot(snapshotPath('local', 'fish-init'))
    await expect(daemon.args?.[2]).toMatchFileSnapshot(snapshotPath('daemon', 'fish-init'))
  })
})

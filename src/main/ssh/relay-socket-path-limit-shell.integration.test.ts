import { execFile } from 'node:child_process'
import { chmod, mkdtemp, mkdir, rm, symlink, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  resolveShortRelaySocketDirCommand,
  shortRelayVersionSegment
} from './relay-socket-path-limit'

const run = promisify(execFile)

// The generated script runs on the remote host's /bin/sh, so assert against a real shell rather
// than a string match: the hazard here is an ordering bug that only a filesystem can observe.
describe('short relay socket dir guard, against a real shell', () => {
  let root: string

  const VERSION_SEGMENT = shortRelayVersionSegment('relay-0.1.0+test')

  // Retarget the generated script at a sandbox instead of the real /tmp path.
  function scriptFor(dir: string): string {
    return resolveShortRelaySocketDirCommand(VERSION_SEGMENT).replace(
      /^dir=.*$/m,
      `dir=${JSON.stringify(dir)}`
    )
  }

  async function attempt(dir: string): Promise<{ ok: boolean; stdout: string }> {
    try {
      const { stdout } = await run('/bin/sh', ['-c', scriptFor(dir)])
      return { ok: true, stdout }
    } catch {
      return { ok: false, stdout: '' }
    }
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-relay-dir-guard-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('creates the directory and its version segment when neither exists', async () => {
    const dir = join(root, 'fresh')
    const attempted = await attempt(dir)
    expect(attempted.ok).toBe(true)
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    // The segment is what keeps a later build off the path this one binds.
    expect((await stat(join(dir, VERSION_SEGMENT))).mode & 0o777).toBe(0o700)
    expect(attempted.stdout.trim().endsWith(`${dir}/${VERSION_SEGMENT}`)).toBe(true)
  })

  it('refuses a planted symlink in the version segment without following it', async () => {
    const dir = join(root, 'mine')
    const victim = join(root, 'segment-victim')
    await mkdir(dir)
    await chmod(dir, 0o700)
    await mkdir(victim)
    await chmod(victim, 0o755)
    await symlink(victim, join(dir, VERSION_SEGMENT))

    const before = (await stat(victim)).mode & 0o777
    expect((await attempt(dir)).ok).toBe(false)
    expect((await stat(victim)).mode & 0o777).toBe(before)
  })

  it('adopts a directory we already own at 0700, so reconnects keep working', async () => {
    // Regression guard: `ls` decorates the mode with @ (xattrs), + (ACL) or . (SELinux), and an
    // exact match refused a directory we own — which would have broken every reconnect.
    const dir = join(root, 'mine')
    await mkdir(dir)
    await chmod(dir, 0o700)
    expect((await attempt(dir)).ok).toBe(true)
    expect((await attempt(dir)).ok).toBe(true)
  })

  it('refuses a planted symlink without changing what it points at', async () => {
    const victim = join(root, 'victim')
    const link = join(root, 'link')
    await mkdir(victim)
    await chmod(victim, 0o755)
    await symlink(victim, link)

    const before = (await stat(victim)).mode & 0o777
    expect((await attempt(link)).ok).toBe(false)
    // The point of the ordering: an unconditional chmod would have followed the link and
    // rewritten the victim's mode before the owner check ever ran.
    expect((await stat(victim)).mode & 0o777).toBe(before)
  })

  it('refuses an existing directory that is not 0700', async () => {
    const dir = join(root, 'loose')
    await mkdir(dir)
    // Explicit chmod: mkdir's mode is masked by the process umask, so the fixture would not
    // actually be world-writable and the test would not be testing what it claims.
    await chmod(dir, 0o777)
    expect((await attempt(dir)).ok).toBe(false)
    expect((await stat(dir)).mode & 0o777).toBe(0o777)
  })
})

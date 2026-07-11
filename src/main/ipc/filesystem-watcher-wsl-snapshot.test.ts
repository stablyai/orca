import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { buildSnapshotScript, parseSnapshotFrame } from './filesystem-watcher-wsl-snapshot'

const temporaryRoots: string[] = []

async function runSnapshotScript(
  root: string,
  statScript: string
): Promise<{ code: number | null; stderr: string; stdout: Buffer }> {
  const bin = join(root, '.test-bin')
  await mkdir(bin)
  const statPath = join(bin, 'stat')
  await writeFile(statPath, statScript)
  await chmod(statPath, 0o700)
  const child = spawn('sh', ['-s', '--', root], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const stdout: Buffer[] = []
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
  child.stdin.end(buildSnapshotScript(['.test-bin'], { forcePortable: true, once: true }))
  const code = await new Promise<number | null>((resolve) => child.once('close', resolve))
  return { code, stderr, stdout: Buffer.concat(stdout) }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})

describe('WSL snapshot compatibility', () => {
  it('selects GNU find fast-path and a batched BusyBox stat fallback', () => {
    const script = buildSnapshotScript(['node_modules'])

    expect(script).toContain('-printf')
    expect(script).toContain('snapshot_find=portable')
    expect(script).toContain('stat -c "%F\t%y"')
    expect(script).toContain('-exec sh -c')
    expect(script).toContain('stat -c "%F\t%y" -- "$@"')
    expect(script).toContain("-name 'node_modules'")
    expect(script).not.toContain('-maxdepth')
  })

  it('parses portable stat metadata and preserves unusual path characters', () => {
    const frame =
      'regular file\t2026-07-09 12:34:56.123456789 +0000\t/home/me/repo/a\nname.md\0' +
      'directory\t2026-07-09 12:34:57.000000000 +0000\t/home/me/repo/docs\0'

    expect([...parseSnapshotFrame(frame, 'Ubuntu').values()]).toEqual([
      {
        type: 'regular file',
        mtime: '2026-07-09 12:34:56.123456789 +0000',
        path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\a\nname.md'
      },
      {
        type: 'directory',
        mtime: '2026-07-09 12:34:57.000000000 +0000',
        path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\docs'
      }
    ])
  })

  it('does not reserve legal filename control bytes as frame markers', () => {
    const path = '/home/me/repo/control-\x1e-\x1f.md'
    const snapshot = parseSnapshotFrame(`f\t1.0\t${path}\0`, 'Ubuntu')

    expect(
      snapshot.get('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\control-\x1e-\x1f.md')
    ).toBeDefined()
  })

  it.skipIf(process.platform === 'win32')(
    'executes the forced portable path and skips files that vanish during a failed stat batch',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-wsl-portable-churn-'))
      temporaryRoots.push(root)
      const vanished = join(root, 'vanished.md')
      const retained = join(root, 'retained.md')
      await writeFile(vanished, 'gone')
      await writeFile(retained, 'kept')
      const marker = join(root, '.batch-failed')
      const result = await runSnapshotScript(
        root,
        `#!/bin/sh
format=$2; shift 3
if test "$#" -gt 1 && test ! -e ${JSON.stringify(marker)}; then
  : >${JSON.stringify(marker)}; rm -f ${JSON.stringify(vanished)}; exit 1
fi
for path do
  test -e "$path" || { echo "stat: $path: No such file or directory" >&2; exit 1; }
  printf 'regular file\\t1\\n'
done
`
      )

      expect(result.code).toBe(0)
      expect(result.stderr).toBe('')
      const frame = result.stdout.toString('utf8')
      expect(frame).toContain(`regular file\t1\t${retained}\0`)
      expect(frame).not.toContain(vanished)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'degrades unreadable entries to a partial frame instead of aborting the poll loop',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-wsl-portable-error-'))
      temporaryRoots.push(root)
      const denied = join(root, 'denied.md')
      const readable = join(root, 'readable.md')
      await writeFile(denied, 'still exists')
      await writeFile(readable, 'fine')
      const result = await runSnapshotScript(
        root,
        `#!/bin/sh
shift 3
if test "$#" -gt 1; then exit 1; fi
if test "$1" = ${JSON.stringify(denied)}; then echo 'permission denied' >&2; exit 1; fi
printf 'regular file\\t1\\n'
`
      )

      // Why: one unreadable subtree must not orphan the whole worktree; the
      // frame still terminates so the engine keeps polling the readable rest.
      expect(result.code).toBe(0)
      expect(result.stderr).toContain('permission denied')
      const frame = result.stdout.toString('utf8')
      expect(frame).toContain(`regular file\t1\t${readable}\0`)
      expect(frame.endsWith('\0\0') || frame === '\0').toBe(true)
    }
  )
})

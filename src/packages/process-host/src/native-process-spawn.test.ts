import { ChildProcess, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NativeExecutableResolver, nativeExecutableResolver } from './native-executable-resolution'
import { execNativeFileSync, spawnNativeProcess } from './native-process-spawn'
import { runProcess, runProcessSync } from './run-process'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-spawn-resolution-'))
  roots.push(root)
  const first = join(root, 'first')
  const second = join(root, 'second')
  await Promise.all([mkdir(first), mkdir(second)])
  return { root, first, second, env: { ...process.env, PATH: `${first}:${second}` } }
}

async function executable(file: string, text: string) {
  await writeFile(file, text)
  await chmod(file, 0o755)
}

describe.skipIf(process.platform === 'win32')('native executable candidates', () => {
  it('rediscovers removed files, PATH changes and earlier installations after a fixed expiry', async () => {
    const { first, second, env } = await fixture()
    let now = 0
    const resolver = new NativeExecutableResolver('darwin', () => now)
    const late = join(second, 'probe')
    const early = join(first, 'probe')
    await executable(late, '#!/bin/sh\necho late\n')
    expect(resolver.resolve('probe', env).file).toBe(late)
    await executable(early, '#!/bin/sh\necho early\n')
    now = 29_000
    expect((await resolver.resolveAsync('probe', env)).file).toBe(late)
    now = 30_001
    expect(resolver.resolve('probe', env).file).toBe(early)
    await rm(early)
    expect((await resolver.resolveAsync('probe', env)).file).toBe(late)
    await executable(early, '#!/bin/sh\necho new\n')
    expect(resolver.resolve('probe', { PATH: first }).file).toBe(early)
    await chmod(late, 0o644)
    expect(resolver.resolve('probe', env).file).toBe(early)
  })

  it('leaves native lookup in charge of absent, empty and relative PATH, explicit paths and other hosts', async () => {
    const { first, second, env } = await fixture()
    await executable(join(second, 'probe'), '#!/bin/sh\nexit 0\n')
    const resolver = new NativeExecutableResolver('darwin')
    for (const PATH of [undefined, '', `:${second}`, `${first}:.:${second}`, `${second}:`]) {
      expect((await resolver.resolveAsync('probe', { PATH })).file).toBe('probe')
    }
    expect(resolver.resolve('./probe', env).file).toBe('./probe')
    for (const host of ['win32', 'linux'] as const) {
      expect(new NativeExecutableResolver(host).resolve('probe', env).file).toBe('probe')
    }
  })

  it('retains filesystem traversal through symlinked PATH directories', async () => {
    const { root } = await fixture()
    await mkdir(join(root, 'actual', 'nested'), { recursive: true })
    await executable(join(root, 'actual', 'probe'), '#!/bin/sh\necho correct\n')
    await executable(join(root, 'probe'), '#!/bin/sh\necho wrong\n')
    await symlink(join(root, 'actual', 'nested'), join(root, 'link'))
    const resolver = new NativeExecutableResolver('darwin')
    expect(resolver.resolve('probe', { PATH: `${root}/link/..` }).file).toBe(
      `${root}/link/../probe`
    )
  })
})

describe.skipIf(process.platform !== 'darwin')('macOS native launch compatibility', () => {
  it('preserves fatal earlier-path errors during discovery, cached validation and immediate repair', async () => {
    const { root, first, second, env } = await fixture()
    await Promise.all([
      symlink(process.execPath, join(first, 'probe')),
      symlink(process.execPath, join(second, 'probe'))
    ])
    const saved = await nativeExecutableResolver.resolveAsync('probe', env)
    await rm(first, { recursive: true })
    await symlink('first', first)
    const marker = join(root, 'marker')
    const args = ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`]
    expect(spawnSync('probe', args, { env }).error).toMatchObject({ code: 'ELOOP' })
    expect(() => runProcessSync({ program: 'probe', args, env })).toThrow(
      expect.objectContaining({ code: 'ELOOP' })
    )
    expect(nativeExecutableResolver.file(saved, env)).toBe('probe')
    const selected = await nativeExecutableResolver.resolveAsync('probe', env)
    expect(selected.file).toBe('probe')
    const error = await new Promise<unknown>((resolve) => {
      try {
        const child = spawnNativeProcess('probe', args, { env, stdio: 'ignore' }, selected)
        child.once('error', resolve)
        child.once('close', () => resolve(null))
      } catch (failure) {
        resolve(failure)
      }
    })
    expect(error).toMatchObject({ code: 'ELOOP' })
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    await rm(first)
    await mkdir(first)
    await symlink(process.execPath, join(first, 'probe'))
    expect(runProcessSync({ program: 'probe', args, env }).code).toBe(0)
    expect(await readFile(marker, 'utf8')).toBe('ran')
  })

  it('preserves native selection and error precedence behind denied files and directories', async () => {
    const { first, second, env } = await fixture()
    const early = join(first, 'probe')
    const late = join(second, 'probe')
    await executable(early, '#!/bin/sh\necho wrong\n')
    await chmod(early, 0o644)
    await symlink(process.execPath, late)
    expect(runProcessSync({ program: 'probe', args: ['-p', 'process.argv0'], env }).stdout).toBe(
      'probe\n'
    )
    await rm(late)
    expect(() => runProcessSync({ program: 'probe', env })).toThrow(
      expect.objectContaining({ code: 'EACCES' })
    )
    await rm(early)
    await mkdir(early)
    await symlink(process.execPath, late)
    const selected = await nativeExecutableResolver.resolveAsync('probe', env)
    expect(selected.file).toBe('probe')
    expect(execNativeFileSync('probe', ['-p', 'process.argv0'], { env, encoding: 'utf8' })).toBe(
      'probe\n'
    )
  })

  it('uses the current PATH when the environment changes after asynchronous selection', async () => {
    const { first, second, env } = await fixture()
    await executable(join(first, 'probe'), '#!/bin/sh\necho first\n')
    await executable(join(second, 'probe'), '#!/bin/sh\necho second\n')
    const selected = await nativeExecutableResolver.resolveAsync('probe', env)
    env.PATH = second
    const child = spawnNativeProcess('probe', [], { env }, selected)
    let output = ''
    child.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    expect(await once(child, 'close')).toEqual([0, null])
    expect(output).toBe('second\n')
  })

  it.each(['missing', 'not-directory'])(
    'returns the real fallback child for a %s interpreter with argv0 and one visible lifecycle',
    async (interpreter) => {
      const { root, first, second, env } = await fixture()
      await writeFile(join(root, 'not-directory'), 'fixture')
      await executable(join(first, 'probe'), `#!${root}/${interpreter}/sh\n`)
      await symlink(process.execPath, join(second, 'probe'))
      const marker = join(root, 'marker')
      const child = spawnNativeProcess(
        'probe',
        [
          '-e',
          `
      require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'ran');
      process.stdin.on('data', data => process.stdout.write(data));
      process.stdin.on('end', () => { process.stderr.write(process.argv0); process.exitCode = 7 });
    `
        ],
        { env }
      )
      expect(child).toBeInstanceOf(ChildProcess)
      expect(child.pid).toBeGreaterThan(0)
      let spawns = 0
      let closes = 0
      child.on('spawn', () => spawns++)
      child.on('close', () => closes++)
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      child.stdout!.on('data', (data: Buffer) => stdout.push(data))
      child.stderr!.on('data', (data: Buffer) => stderr.push(data))
      child.stdin!.end(Buffer.from([0, 255, 128]))
      expect(await once(child, 'close')).toEqual([7, null])
      expect(Buffer.concat(stdout)).toEqual(Buffer.from([0, 255, 128]))
      expect(Buffer.concat(stderr).toString()).toBe('probe')
      expect(await readFile(marker, 'utf8')).toBe('ran')
      expect({ spawns, closes }).toEqual({ spawns: 1, closes: 1 })
      // A bypass still runs native discovery, so repairing the earlier command is immediately usable.
      await rm(join(first, 'probe'))
      await symlink(process.execPath, join(first, 'probe'))
      expect(execNativeFileSync('probe', ['-p', 'process.argv0'], { env, encoding: 'utf8' })).toBe(
        'probe\n'
      )
    }
  )

  it('does not let a missing cwd disable the shortcut in a healthy folder, and exposes native failure', async () => {
    const { root, second, env } = await fixture()
    const file = join(second, 'probe')
    await symlink(process.execPath, file)
    const failed = spawnNativeProcess('probe', [], { env, cwd: join(root, 'missing') })
    await expect(once(failed, 'close')).rejects.toMatchObject({ code: 'ENOENT', path: 'probe' })
    const healthy = spawnNativeProcess('probe', ['-e', ''], { env, cwd: root })
    expect(healthy.spawnfile).toBe(file)
    expect(await once(healthy, 'close')).toEqual([0, null])
    await rm(file)
    const absent = spawnNativeProcess('probe', [], { env })
    await expect(once(absent, 'close')).rejects.toMatchObject({ code: 'ENOENT', path: 'probe' })
  })

  it('never replays a started nonzero or timed out operation, including synchronous capture', async () => {
    const { root, second, env } = await fixture()
    await symlink(process.execPath, join(second, 'probe'))
    const marker = join(root, 'marker')
    const write = `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'ran');`
    expect(() =>
      execNativeFileSync('probe', ['-e', `${write}process.exitCode=9`], {
        env,
        stdio: 'pipe'
      })
    ).toThrow('Command failed: probe')
    let terminated = 0
    const result = await runProcess({
      program: 'probe',
      args: ['-e', `${write}setInterval(()=>{},1000)`],
      env,
      timeoutMs: 1_000,
      onChildTerminated: () => terminated++
    })
    expect(result.timedOut).toBe(true)
    expect(terminated).toBe(1)
    expect(await readFile(marker, 'utf8')).toBe('ranran')
  })

  it('falls back in synchronous capture without changing successful argv0 or retrying nonzero exits', async () => {
    const { root, first, second, env } = await fixture()
    await executable(join(first, 'probe'), '#!/missing/orca-interpreter\n')
    await symlink(process.execPath, join(second, 'probe'))
    expect(execNativeFileSync('probe', ['-p', 'process.argv0'], { env, encoding: 'utf8' })).toBe(
      'probe\n'
    )
    await executable(join(first, 'probe-sync'), '#!/missing/orca-interpreter\n')
    await symlink(process.execPath, join(second, 'probe-sync'))
    expect(
      runProcessSync({ program: 'probe-sync', args: ['-p', 'process.argv0'], env })
    ).toMatchObject({
      code: 0,
      stdout: 'probe-sync\n'
    })
    // A file disappearing after asynchronous selection is still safe at the actual spawn seam.
    await rm(join(first, 'probe'))
    const fresh = { ...env, PATH: second }
    const selected = await nativeExecutableResolver.resolveAsync('probe', fresh)
    await rm(join(second, 'probe'))
    const child = spawnNativeProcess('probe', [], { env: fresh, cwd: root }, selected)
    await expect(once(child, 'close')).rejects.toMatchObject({ code: 'ENOENT', path: 'probe' })
  })
})

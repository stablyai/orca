import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess, spawnProcess } from '../../shared/child-process/run-process'

async function verify(): Promise<void> {
  assert.equal(process.platform, 'win32')
  const app = join(__dirname, 'packaged app')
  const resources = join(app, 'resources')
  const bin = join(resources, 'bin')
  const runtimeDirectory = join(resources, 'cli-runtime')
  const cliDirectory = join(resources, 'app.asar.unpacked', 'out', 'cli')
  for (const directory of [bin, runtimeDirectory, cliDirectory]) {
    await mkdir(directory, { recursive: true })
  }
  const runtime = join(runtimeDirectory, 'bun-runtime.exe')
  await copyFile(process.execPath, runtime)
  await writeFile(join(app, 'Orca.exe'), '')
  await copyFile(join(__dirname, 'owner-entry.cjs'), join(cliDirectory, 'index.js'))
  const windows = process.env.SystemRoot || 'C:\\Windows'
  const compiler = ['Framework64', 'Framework']
    .map((directory) => join(windows, 'Microsoft.NET', directory, 'v4.0.30319', 'csc.exe'))
    .find(existsSync)
  assert(compiler, 'The Windows C# compiler is required')
  const launcher = join(bin, 'orca.exe')
  const compiled = await runProcess({
    program: compiler,
    args: [
      '/nologo',
      '/target:exe',
      '/optimize+',
      '/warnaserror+',
      `/out:${launcher}`,
      join(__dirname, 'OrcaCliLauncher.cs')
    ],
    timeoutMs: 30_000
  })
  assert.equal(compiled.code, 0, compiled.stderr || compiled.stdout)
  await writeFile(join(app, 'bunfig.toml'), 'preload = ["./preload.cjs"]\n')
  await writeFile(join(app, 'preload.cjs'), 'throw new Error("Workspace preload executed")')
  const args = ['two words', 'a"b', 'line\nbreak', '', 'tail\\', 'quote\\"end', '$HOME']
  const result = await runProcess({
    program: launcher,
    args,
    cwd: app,
    env: {
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_APP_EXECUTABLE: '',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '--invalid-option',
      BUN_OPTIONS: '--invalid-option'
    },
    timeoutMs: 15_000
  })
  assert.equal(result.code, 17, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    args,
    bun: process.versions.bun,
    app: join(app, 'Orca.exe'),
    nodeMode: null,
    packaged: '1'
  })
  for (const mode of ['cli', 'serve'] as const) {
    if (mode === 'serve') {
      assert(process.env.ORCA_SERVE_TEST_EXECUTABLE, 'A Node child executable is required')
      await copyFile(join(__dirname, 'serve-owner-entry.cjs'), join(cliDirectory, 'index.js'))
    }
    const parent = spawnProcess({
      program: launcher,
      args:
        mode === 'cli'
          ? ['--owner-wait']
          : [process.env.ORCA_SERVE_TEST_EXECUTABLE!, __dirname, '--launcher-owner'],
      env: { ORCA_BACKGROUND_LAUNCH: '1' }
    })
    const signal = AbortSignal.timeout(10_000)
    const closed = once(parent, 'close', { signal })
    void closed.catch(() => {})
    const lines = createInterface({ input: parent.stdout })
    let childPid: number | undefined
    let descendantPid: number | undefined
    let output = ''
    parent.stdout.on('data', (chunk) => {
      output += chunk.toString()
    })
    parent.stderr.resume()
    try {
      const [line] = await once(lines, 'line', { signal })
      const ready = JSON.parse(line)
      assert.equal(typeof ready.pid, 'number')
      assert.equal(ready.ownerPipe, null)
      childPid = ready.pid
      descendantPid = ready.descendantPid
      parent.kill()
      await closed
      if (mode === 'cli') {
        assert.match(output, /owner-loss-shutdown/)
      } else {
        assert.match(output, /Bun supervisor verified/)
        assert.equal(
          await readFile(join(__dirname, 'shutdown-drain.txt'), 'utf8'),
          'shutdown-drained'
        )
      }
      childPid = undefined
      descendantPid = undefined
    } finally {
      lines.close()
      parent.kill()
      for (const pid of [childPid, descendantPid]) {
        if (!pid) {
          continue
        }
        try {
          process.kill(pid)
        } catch (error) {
          assert(error instanceof Error && 'code' in error && error.code === 'ESRCH')
        }
      }
    }
  }
  await rename(runtime, `${runtime}.missing`)
  const missing = await runProcess({ program: launcher, args: [], timeoutMs: 15_000 })
  assert.equal(missing.code, 78, missing.stderr)
  console.log(
    'Windows native Bun launcher argv, environment, exit and missing-runtime checks passed'
  )
}

void verify().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})

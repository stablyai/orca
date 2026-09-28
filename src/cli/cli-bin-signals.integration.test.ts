import { once } from 'node:events'
import { pathToFileURL } from 'node:url'
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { build } from 'esbuild'
import { describe, expect, it, onTestFailed, vi } from 'vitest'
import { runProcess, spawnProcess } from '../shared/child-process/run-process'

const runtime = process.env.BUN_EXECUTABLE

describe.skipIf(!runtime).each(['public', 'developer'])('%s CLI launcher ownership', (kind) => {
  async function runScenario(mode: 'group' | 'parent' | 'owner-loss' | 'suspend'): Promise<void> {
    if (!runtime) {
      throw new Error('BUN_EXECUTABLE is required')
    }
    const root = await mkdtemp(join(tmpdir(), 'orca-cli-signals-'))
    const cli = join(root, 'out', 'cli')
    const runtimeDirectory = join(root, 'out/cli-runtime', `${process.platform}-${process.arch}`)
    let runtimePid: number | undefined
    const report = join(root, 'report.json')
    const started = Date.now()
    let phase = 'fixture directories'
    let failurePhase: string | undefined
    let stderr = ''
    onTestFailed(() => {
      console.error('CLI launcher failure', {
        kind,
        mode,
        phase: failurePhase ?? phase,
        elapsedMs: Date.now() - started,
        runtimePid,
        stderr
      })
    })
    try {
      await mkdir(cli, { recursive: true })
      await mkdir(runtimeDirectory, { recursive: true })
      phase = 'runtime copy'
      await (process.platform === 'win32'
        ? copyFile(runtime, join(runtimeDirectory, 'bun-runtime.exe'))
        : symlink(runtime, join(runtimeDirectory, 'bun-runtime')))
      phase = 'launcher fixture'
      await copyFile(join(process.cwd(), 'out/cli/cli-bin.js'), join(cli, 'cli-bin.js'))
      let launcherEntry = join(cli, 'cli-bin.js')
      if (kind === 'developer') {
        for (const file of [
          'out/cli/cli-bun-launcher.js',
          'config/bundled-cli-runtime.cjs',
          'config/scripts/orca-dev.mjs',
          'config/scripts/dev-cli-terminal-wrapper.mjs'
        ]) {
          await mkdir(join(root, file, '..'), { recursive: true })
          await copyFile(join(process.cwd(), file), join(root, file))
        }
        launcherEntry = join(root, 'config/scripts/orca-dev.mjs')
      }
      phase = 'application build'
      await build({
        stdin: {
          resolveDir: __dirname,
          contents: `
            import { writeFileSync } from 'node:fs';
            import { installCliLauncherOwner } from './runtime/cli-launcher-owner';
            installCliLauncherOwner();
            let count=0;
            process.on('SIGINT',()=>{
              if (++count===1) setTimeout(()=>{
                writeFileSync(${JSON.stringify(report)},JSON.stringify({count}));
                process.exit(0);
              },200);
            });
            process.on('SIGTERM',()=>{
              writeFileSync(${JSON.stringify(report)},JSON.stringify({ownerLost:true}));
              process.exit(0);
            });
            setInterval(()=>{},1000);
            console.log(JSON.stringify({pid:process.pid}));
          `
        },
        outfile: join(cli, 'index.js'),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'es2024'
      })
      if (process.platform === 'win32' && mode === 'parent') {
        const entry = launcherEntry
        launcherEntry = join(root, 'signal-launcher.cjs')
        await writeFile(
          launcherEntry,
          `process.argv[1]=${JSON.stringify(entry)};import(${JSON.stringify(pathToFileURL(entry).href)});setTimeout(()=>process.emit('SIGINT','SIGINT'),1500)`
        )
      }
      phase = 'launcher spawn'
      const launcher = spawnProcess({
        program:
          kind === 'public'
            ? (process.env.ORCA_CLI_BOOTSTRAP_NODE ?? process.execPath)
            : process.execPath,
        args: [launcherEntry],
        detached: true,
        env: {
          ORCA_BACKGROUND_LAUNCH: '1',
          BUN_OPTIONS: '',
          NODE_OPTIONS: '',
          ORCA_DEV_USER_DATA_PATH: join(root, 'user-data'),
          ORCA_APP_EXECUTABLE: process.execPath
        }
      })
      const signal = AbortSignal.timeout(5_000)
      const closed = once(launcher, 'close', { signal })
      void closed.catch(() => {})
      launcher.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4096)
      })
      const lines = createInterface({ input: launcher.stdout })
      try {
        phase = 'application readiness'
        const [line] = await once(lines, 'line', { signal })
        const ready = JSON.parse(line)
        if (typeof ready.pid !== 'number' || !launcher.pid) {
          throw new Error('Launcher did not report its child process')
        }
        runtimePid = ready.pid
        if (mode === 'suspend') {
          launcher.kill('SIGTSTP')
          const pids = `${launcher.pid},${runtimePid}`
          await vi.waitFor(async () => {
            const state = await runProcess({ program: 'ps', args: ['-o', 'stat=', '-p', pids] })
            expect(state.stdout.trim().split(/\s+/)).toEqual([
              expect.stringContaining('T'),
              expect.stringContaining('T')
            ])
          })
          launcher.kill('SIGCONT')
        }
        phase = 'signal delivery'
        if (mode === 'owner-loss') {
          launcher.kill('SIGKILL')
        } else if (process.platform !== 'win32') {
          process.kill(mode === 'group' ? -launcher.pid : launcher.pid, 'SIGINT')
        }
        phase = 'launcher close'
        await closed
        phase = 'shutdown receipt'
        await vi.waitFor(async () => {
          expect(JSON.parse(await readFile(report, 'utf8'))).toEqual(
            mode === 'owner-loss' ? { ownerLost: true } : { count: 1 }
          )
        })
        phase = 'child exit'
        await vi.waitFor(
          () => {
            let exited = false
            try {
              process.kill(ready.pid, 0)
            } catch (error) {
              expect(error).toMatchObject({ code: 'ESRCH' })
              exited = true
            }
            expect(exited).toBe(true)
          },
          { timeout: 5_000 }
        )
        runtimePid = undefined
      } finally {
        lines.close()
        launcher.kill('SIGKILL')
      }
    } catch (error) {
      failurePhase = phase
      throw error
    } finally {
      phase = 'fixture cleanup'
      if (runtimePid) {
        try {
          process.kill(runtimePid, 'SIGKILL')
        } catch (error) {
          expect(error).toMatchObject({ code: 'ESRCH' })
        }
      }
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }

  const modes: ('group' | 'parent' | 'owner-loss' | 'suspend')[] =
    process.platform === 'win32'
      ? ['owner-loss', 'parent']
      : ['group', 'parent', 'owner-loss', 'suspend']
  it.each(modes)(
    'handles %s termination without duplicate signals or an orphan',
    runScenario,
    15_000
  )
})

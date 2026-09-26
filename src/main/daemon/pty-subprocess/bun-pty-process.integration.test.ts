import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess, runProcessSync } from '../../../shared/child-process/run-process'
import { orcadBunRuntimeFilename } from '../../../shared/orcad-artifacts'
import { ORCAD_BUN_VERSION } from '../../../shared/orcad-bun-runtime'
import { removeTreeSync } from '../../../shared/windows-transient-lock-removal'

const runtimePath =
  process.env.BUN_EXECUTABLE ??
  resolve(__dirname, '../../../../out/orcad', orcadBunRuntimeFilename(process.platform))

async function runTerminalScript(script: string): Promise<unknown> {
  expect(runProcessSync({ program: runtimePath, args: ['--version'] }).stdout.trim()).toBe(
    ORCAD_BUN_VERSION
  )
  const directory = mkdtempSync(join(tmpdir(), 'orca-bun-terminal-'))
  try {
    const entry = join(directory, 'terminal.cjs')
    writeFileSync(
      entry,
      [
        `const {spawnBunPty} = require(${JSON.stringify(join(__dirname, 'bun-pty-process.ts'))})`,
        `const args = {file: process.execPath, cwd: ${JSON.stringify(directory)}, env: process.env, cols: 80, rows: 24}`,
        script
      ].join('\n')
    )
    const result = await runProcess({ program: runtimePath, args: [entry], timeoutMs: 30_000 })
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    return JSON.parse(result.stdout)
  } finally {
    removeTreeSync(directory)
  }
}

describe.skipIf(!existsSync(runtimePath) || process.platform === 'win32')(
  'real Bun terminal',
  () => {
    it('drains multi-byte output before publishing process exit and applies resize', async () => {
      const result = await runTerminalScript(`
      const expected = '⌘状態'.repeat(200_000)
      const proc = spawnBunPty({...args, args: ['-e', 'process.stdout.write("⌘状態".repeat(200000));process.exitCode=17']})
      let output = ''
      proc.resize(103, 37)
      proc.onData(data => output += data)
      proc.onExit(event => {
        console.log(JSON.stringify({event, exact: output === expected, cols:proc.cols, rows:proc.rows}))
        proc.destroy()
      })
    `)
      expect(result).toEqual({ event: { exitCode: 17 }, exact: true, cols: 103, rows: 37 })
    })

    it('receives the real shell identity from a gated Bun subprocess', async () => {
      const result = await runTerminalScript(`
      const {createWindowsBunPtyLaunch} = require(${JSON.stringify(join(__dirname, 'windows-bun-pty-launch.ts'))})
      const proc = spawnBunPty({...args,args:['-e','setTimeout(()=>{process.exitCode=17},100)']}, {
        platform:'win32', assignHostJob:()=>true,
        createJob:()=>({listProcessIds:()=>[], pause:()=>true,resume:()=>true,terminate:()=> 'terminated',close(){}}),
        createWindowsLaunch:launch => createWindowsBunPtyLaunch(launch, {
          runtimePath:process.execPath,workerPath:${JSON.stringify(join(__dirname, 'windows-bun-pty-gate-entry.ts'))}
        })
      })
      proc.onExit(event => {
        console.log(JSON.stringify({event, shellIdentified:proc.shellProcessId>0 && proc.shellProcessId!==proc.pid}))
        proc.destroy()
      })
    `)
      expect(result).toEqual({ event: { exitCode: 17 }, shellIdentified: true })
    })

    it('reports signal termination distinctly from an ordinary exit', async () => {
      const result = await runTerminalScript(`
      const proc = spawnBunPty({...args,args:['-e', 'console.log("ready");setInterval(()=>{},1000)']})
      proc.onData(() => proc.kill('SIGTERM'))
      proc.onExit(event => { console.log(JSON.stringify(event));proc.destroy() })
    `)
      expect(result).toEqual({ exitCode: 143, signal: 15 })
    })

    it('pauses and resumes the owned process when process discovery is unavailable', async () => {
      const result = await runTerminalScript(`
      const expected = 'ready' + 'x'.repeat(1024 * 1024)
      const continueOutput = require('node:path').join(args.cwd, 'continue-output')
      const proc = spawnBunPty({...args,env:{...args.env,ORCA_TEST_CONTINUE:continueOutput},args:['-e','process.stdout.write("ready");const timer=setInterval(()=>{if(!require("node:fs").existsSync(process.env.ORCA_TEST_CONTINUE))return;clearInterval(timer);process.stdout.write("x".repeat(1024*1024))},1)']},{readProcessTable:()=>''})
      let output = '', paused = false, stable = false
      proc.onData(data => {
        output += data
        if (paused) return
        paused = true
        proc.pause()
        setTimeout(() => {
          const settled = output.length
          require('node:fs').writeFileSync(continueOutput, 'continue')
          setTimeout(() => { stable = output.length === settled;proc.resume() }, 150)
        }, 150)
      })
      proc.onExit(event => {
        console.log(JSON.stringify({event,stable,exact:output===expected}))
        proc.destroy()
      })
    `)
      expect(result).toEqual({ event: { exitCode: 0 }, stable: true, exact: true })
    })

    it.skipIf(!existsSync('/bin/bash')).each([
      [false, 0],
      [false, 100],
      [true, 0],
      [true, 100]
    ] as const)(
      'stops foreground and background floods without losing output (resume failure: %s, signal gap: %sms)',
      async (rejectFirstResume, stopSignalGapMs) => {
        const result = await runTerminalScript(`
      const expected = 16 * 1024 * 1024
      const {join} = require('node:path')
      const {writeFileSync,existsSync} = require('node:fs')
      const producer = join(args.cwd, 'producer.cjs')
      const backgroundReady = join(args.cwd, 'background-ready')
      const foregroundReady = join(args.cwd, 'foreground-ready')
      const go = join(args.cwd, 'go')
      const continueOutput = join(args.cwd, 'continue-output')
      writeFileSync(producer, [
        'const {writeFileSync,existsSync}=require("node:fs")',
        'writeFileSync(process.argv[2],"ready")',
        'const deadline=setTimeout(()=>process.exit(97),10000)',
        'const ready=setInterval(()=>{if(!existsSync(process.argv[3]))return;clearInterval(ready);process.stdout.write("x".repeat(65536));const continued=setInterval(()=>{if(!existsSync(process.argv[4]))return;clearInterval(continued);clearTimeout(deadline);let count=1;const timer=setInterval(()=>{process.stdout.write("x".repeat(65536));if(++count===128)clearInterval(timer)},1)},1)},1)'
      ].join(';'))
      const groups = new Set()
      let bytes = 0, paused = false, settledBytes = 0, stable = false, verifying = false, rejectedResume = false
      const proc = spawnBunPty({
        ...args, file:'/bin/bash',
        args:['--noprofile','--norc','-i','-c','exec 2>/dev/null; "$ORCA_TEST_RUNTIME" "$ORCA_TEST_PRODUCER" "$ORCA_TEST_BACKGROUND_READY" "$ORCA_TEST_GO" "$ORCA_TEST_CONTINUE" & "$ORCA_TEST_RUNTIME" "$ORCA_TEST_PRODUCER" "$ORCA_TEST_FOREGROUND_READY" "$ORCA_TEST_GO" "$ORCA_TEST_CONTINUE"; wait'],
        env:{...args.env,ORCA_TEST_RUNTIME:process.execPath,ORCA_TEST_PRODUCER:producer,ORCA_TEST_BACKGROUND_READY:backgroundReady,ORCA_TEST_FOREGROUND_READY:foregroundReady,ORCA_TEST_GO:go,ORCA_TEST_CONTINUE:continueOutput}
      },{signalProcessGroup:(pgid,signal)=>{
        if (signal === 'SIGCONT' && ${rejectFirstResume} && !rejectedResume) {
          rejectedResume = true
          throw Object.assign(new Error('transient resume failure'), {code:'EPERM'})
        }
        process.kill(-pgid,signal)
        if (signal === 'SIGSTOP') {
          groups.add(pgid)
          // Give Bash time to react between signals; stopping its jobs first can end its wait.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${stopSignalGapMs})
        }
        if (groups.size < 3 || verifying) return
        verifying = true
        writeFileSync(continueOutput, 'continue')
        setTimeout(() => {
          settledBytes = bytes
          setTimeout(() => { stable = bytes === settledBytes;proc.resume() }, 150)
        },150)
      }})
      const ready = setInterval(() => {
        if (!existsSync(backgroundReady) || !existsSync(foregroundReady)) return
        clearInterval(ready)
        writeFileSync(go, 'go')
      }, 5)
      let beats = 0
      const heartbeat = setInterval(() => beats++, 5)
      proc.onData(data => {
        bytes += data.length
        // Drain both initial writes before measuring whether stopped producers emit more.
        if (!paused && bytes === 2 * 65536) {
          paused = true
          proc.pause()
        }
      })
      proc.onExit(event => {
        clearInterval(ready)
        clearInterval(heartbeat)
        console.log(JSON.stringify({event,stable,exact:bytes===expected,pausedBeforeExit:settledBytes<expected,responsive:beats>10,jobControlGroups:groups.size>=3,rejectedResume}))
        proc.destroy()
      })
    `)
        expect(result).toEqual({
          event: { exitCode: 0 },
          stable: true,
          exact: true,
          pausedBeforeExit: true,
          responsive: true,
          jobControlGroups: true,
          rejectedResume: rejectFirstResume
        })
      }
    )
  }
)

describe.skipIf(!existsSync(runtimePath) || process.platform !== 'win32')(
  'native Windows Bun terminal',
  () => {
    it('falls back after actual shell spawn rejection and cleans each private launch directory', async () => {
      const result = await runTerminalScript(`
      const {spawnNativeDaemonPty} = require(${JSON.stringify(join(__dirname, 'native-pty-spawn.ts'))})
      const {createWindowsBunPtyLaunch} = require(${JSON.stringify(join(__dirname, 'windows-bun-pty-launch.ts'))})
      const {existsSync} = require('node:fs')
      const {dirname,join} = require('node:path')
      const directories = []
      const attempts = [join(args.cwd,'missing-pwsh.exe'),join(args.cwd,'missing-powershell.exe'),process.execPath].map(shellPath=>({
        shellPath,shellArgs:['-e','process.exitCode=17'],effectiveCwd:args.cwd,validationCwd:args.cwd,startupCommandDeliveredInShellArgs:true
      }))
      spawnNativeDaemonPty({
        shellPath:attempts[0].shellPath,shellArgs:attempts[0].shellArgs,spawnCwd:args.cwd,
        env:args.env,cols:80,rows:24,windowsFallbackAttempts:attempts
      }, {canUseBunPty:()=>true, spawnBunPty:options=>spawnBunPty(options, {
        createWindowsLaunch:launchArgs=>{
          const launch = createWindowsBunPtyLaunch(launchArgs, {
            runtimePath:process.execPath,workerPath:${JSON.stringify(join(__dirname, 'windows-bun-pty-gate-entry.ts'))}
          })
          directories.push(dirname(launch.command.at(-1)))
          return launch
        }
      })}).then(({process:proc,shellPath})=>{
        proc.onExit(event=>{
          console.log(JSON.stringify({event,fallback:shellPath===process.execPath,attempts:directories.length,cleaned:directories.every(path=>!existsSync(path))}))
          proc.destroy()
        })
      }).catch(error=>{console.error(error);process.exitCode=1})
    `)
      expect(result).toEqual({
        event: { exitCode: 17 },
        fallback: true,
        attempts: 3,
        cleaned: true
      })
    }, 35_000)

    it('enumerates and suspends a native job with more than 64 processes', async () => {
      const result = await runTerminalScript(`
      const {createWindowsBunPtyLaunch} = require(${JSON.stringify(join(__dirname, 'windows-bun-pty-launch.ts'))})
      const script = 'for(let i=0;i<65;i++)Bun.spawn([process.execPath,"-e","setInterval(()=>{},1000)"],{stdin:"ignore",stdout:"ignore",stderr:"ignore"});setInterval(()=>console.log("tick"),10)'
      const proc = spawnBunPty({...args,args:['-e',script]}, {
        createWindowsLaunch:launch => createWindowsBunPtyLaunch(launch, {
          runtimePath:process.execPath,workerPath:${JSON.stringify(join(__dirname, 'windows-bun-pty-gate-entry.ts'))}
        })
      })
      let bytes=0,started=false,evidence
      proc.onData(data=>{
        bytes+=data.length
        if(started || !data.includes('tick'))return
        const members=proc.listOwnedProcessIds()
        if(!members || members.length<67)return
        started=true
        proc.pause()
        setTimeout(()=>{
          const pausedBytes=bytes
          setTimeout(()=>{
            const stopped=bytes===pausedBytes
            proc.resume()
            setTimeout(()=>{
              evidence={members:members.length,stopped,resumed:bytes>pausedBytes}
              proc.kill()
            },150)
          },150)
        },150)
      })
      proc.onExit(()=>{
        console.log(JSON.stringify(evidence))
        proc.destroy()
      })
    `)
      expect(result).toEqual({ members: 67, stopped: true, resumed: true })
    }, 35_000)

    it('opens ConPTY without IPC and identifies the shell inside its job', async () => {
      const result = await runTerminalScript(`
      const {createWindowsBunPtyLaunch} = require(${JSON.stringify(join(__dirname, 'windows-bun-pty-launch.ts'))})
      const proc = spawnBunPty({...args,args:['-e','console.log("ready");setInterval(()=>{},1000)']}, {
        createWindowsLaunch:launch => createWindowsBunPtyLaunch(launch, {
          runtimePath:process.execPath,workerPath:${JSON.stringify(join(__dirname, 'windows-bun-pty-gate-entry.ts'))}
        })
      })
      let output = '', evidence
      proc.onData(data => output += data)
      const timer = setInterval(() => {
        const shell = proc.shellProcessId
        const members = proc.listOwnedProcessIds()
        if (!output.includes('ready') || !shell || !members?.includes(shell)) return
        clearInterval(timer)
        evidence = {distinctShell:shell!==proc.pid, gateOwned:members.includes(proc.pid), shellOwned:true}
        proc.kill()
      }, 10)
      proc.onExit(event => {
        clearInterval(timer)
        console.log(JSON.stringify({evidence, exited:event.exitCode!==undefined}))
        proc.destroy()
      })
    `)
      expect(result).toEqual({
        evidence: { distinctShell: true, gateOwned: true, shellOwned: true },
        exited: true
      })
    })
  }
)

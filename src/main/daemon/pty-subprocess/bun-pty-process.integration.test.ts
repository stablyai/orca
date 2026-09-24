import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess, runProcessSync } from '../../../shared/child-process/run-process'
import { orcadBunRuntimeFilename } from '../../../shared/orcad-artifacts'
import { ORCAD_BUN_VERSION } from '../../../shared/orcad-bun-runtime'

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
    const result = await runProcess({ program: runtimePath, args: [entry], timeoutMs: 15_000 })
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    return JSON.parse(result.stdout)
  } finally {
    rmSync(directory, { recursive: true, force: true })
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

    it('stops a flooding producer and resumes without losing output', async () => {
      const result = await runTerminalScript(`
      const expected = 16 * 1024 * 1024
      const proc = spawnBunPty({...args,args:['-e','let count=0;const timer=setInterval(()=>{process.stdout.write("x".repeat(65536));if(++count===256)clearInterval(timer)},1)']})
      let bytes = 0, paused = false, settledBytes = 0, stable = false
      proc.onData(data => {
        bytes += data.length
        if (!paused) {
          paused = true
          proc.pause()
          setTimeout(() => {
            settledBytes = bytes
            setTimeout(() => { stable = bytes === settledBytes;proc.resume() }, 150)
          },150)
        }
      })
      proc.onExit(event => {
        console.log(JSON.stringify({event,stable,exact:bytes===expected,pausedBeforeExit:settledBytes<expected}))
        proc.destroy()
      })
    `)
      expect(result).toEqual({
        event: { exitCode: 0 },
        stable: true,
        exact: true,
        pausedBeforeExit: true
      })
    })
  }
)

describe.skipIf(!existsSync(runtimePath) || process.platform !== 'win32')(
  'native Windows Bun terminal',
  () => {
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

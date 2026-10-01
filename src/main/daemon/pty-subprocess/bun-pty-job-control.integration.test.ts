import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '../../../shared/child-process/run-process'
import { orcadBunRuntimeFilename } from '../../../shared/orcad-artifacts'
import { removeTreeSync } from '../../../shared/windows-transient-lock-removal'

const runtimePath =
  process.env.BUN_EXECUTABLE ??
  resolve(__dirname, '../../../../out/orcad', orcadBunRuntimeFilename(process.platform))

describe.skipIf(
  process.platform === 'win32' || !existsSync(runtimePath) || !existsSync('/bin/bash')
)('Bun terminal user job control', () => {
  // Bash re-raises SIGHUP; Zsh exits with the signal number.
  for (const [shell, expectedExitCode] of [
    ['/bin/bash', 129],
    ['/bin/zsh', 1]
  ] as const) {
    it.skipIf(!existsSync(shell))(
      `gracefully closes an interactive ${shell} before the daemon force-kill deadline`,
      async () => {
        const directory = mkdtempSync(join(tmpdir(), 'orca-bun-shell-hangup-'))
        try {
          const entry = join(directory, 'shell-hangup.cjs')
          writeFileSync(
            entry,
            `
const {spawnBunPty} = require(${JSON.stringify(join(__dirname, 'bun-pty-process.ts'))})
const {createDaemonPtySubprocessHandle} = require(${JSON.stringify(join(__dirname, 'subprocess-handle.ts'))})
const {SessionTerminationController} = require(${JSON.stringify(join(__dirname, '../session-termination-controller.ts'))})
const {existsSync} = require('node:fs')
const {join} = require('node:path')
const cwd = ${JSON.stringify(directory)}
const ready = join(cwd, 'ready'), cleanup = join(cwd, 'hangup-cleanup')
const shell = ${JSON.stringify(shell)}
const env = {...process.env,PS1:'',ORCA_TEST_READY:ready,ORCA_TEST_CLEANUP:cleanup}
const proc = spawnBunPty({file:shell,args:shell.endsWith('/bash')?['--noprofile','--norc','-i']:['-f','-i'],cwd,env,cols:80,rows:24})
const subprocess = createDaemonPtySubprocessHandle({process:proc,shellPath:shell,spawnCwd:cwd,env,startupCommandDeliveredInShellArgs:false,reportsChildExitStatus:true,sessionId:'shell-hangup',startupAgentRecognition:null})
let exited = false, forced = false, exitCode, elapsedMs, startedAt
const forceKill = subprocess.forceKill
subprocess.forceKill = () => {forced = true;forceKill()}
const controller = new SessionTerminationController({sessionId:'shell-hangup',subprocess,launchAgent:null,isExited:()=>exited,releaseProducerPause:()=>proc.resume()})
subprocess.onExit(code => {
  exited = true
  exitCode = code
  elapsedMs = Date.now() - startedAt
  controller.markPhysicalExit()
  controller.cancelForceKillFallback()
})
const waitFor = async predicate => {
  const deadline = Date.now() + 8000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for shell hangup')
    await Bun.sleep(10)
  }
}
;(async()=>{
  try {
    // Observe normal hangup cleanup without replacing the shell's SIGHUP handler.
    proc.write(${JSON.stringify('trap \'printf cleaned > "$ORCA_TEST_CLEANUP"\' EXIT; printf ready > "$ORCA_TEST_READY"\r')})
    await waitFor(() => existsSync(ready))
    startedAt = Date.now()
    controller.kill()
    await waitFor(() => exited)
    let reaped = false
    try {process.kill(proc.pid, 0)} catch (error) {if(error.code==='ESRCH')reaped=true;else throw error}
    console.log(JSON.stringify({cleaned:existsSync(cleanup),forced,exitCode,elapsedMs,reaped}))
  } finally {
    controller.cancelForceKillFallback()
    if (!exited) {
      subprocess.forceKill()
      await waitFor(() => exited)
    }
    controller.disposeSubprocessHandle()
  }
})().catch(error => {console.error(error);process.exitCode=1})
`
          )
          const result = await runProcess({
            program: runtimePath,
            args: [entry],
            timeoutMs: 25_000
          })
          expect(result.timedOut).toBe(false)
          expect(result.code, result.stderr).toBe(0)
          const evidence = JSON.parse(result.stdout)
          expect(evidence).toEqual({
            cleaned: true,
            forced: false,
            exitCode: expectedExitCode,
            elapsedMs: expect.any(Number),
            reaped: true
          })
          expect(evidence.elapsedMs).toBeLessThan(5_000)
        } finally {
          removeTreeSync(directory)
        }
      }
    )
  }

  it('keeps a real Ctrl-Z job suspended while pausing and resuming a background producer', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-bun-job-control-'))
    try {
      writeFileSync(join(directory, 'producer.cjs'), 'setInterval(()=>console.log("flow-tick"),10)')
      writeFileSync(
        join(directory, 'sleeper.sh'),
        'printf \'%s\' "$$" > sleeper-ready\nexec sleep 30\n'
      )
      const entry = join(directory, 'job-control.cjs')
      writeFileSync(
        entry,
        `
const {spawnBunPty} = require(${JSON.stringify(join(__dirname, 'bun-pty-process.ts'))})
const {readPosixPtyProcessTable,forceKillPosixPtyProcessGroups} = require(${JSON.stringify(join(__dirname, '../../pty/posix-pty-process-groups.ts'))})
const {existsSync,readFileSync} = require('node:fs')
const ready = ${JSON.stringify(join(directory, 'sleeper-ready'))}
const signals = []
const proc = spawnBunPty({
  file:'/bin/bash', args:['--noprofile','--norc','-i'], cwd:${JSON.stringify(directory)},
  env:{...process.env,PS1:'',ORCA_TEST_RUNTIME:process.execPath},cols:80,rows:24
}, {signalProcessGroup:(pgid,signal)=>{process.kill(-pgid,signal);signals.push([pgid,signal])}})
let output = '', exited = false
proc.onData(data => output += data)
proc.onExit(() => {exited = true})
const isAlive = pid => {
  try {process.kill(pid, 0);return true}
  catch (error) {if(error.code==='ESRCH')return false;throw error}
}
const rows = async () => {
  const table = (await readPosixPtyProcessTable(proc.pid)).trim().split(/\\r?\\n/).map(row => {
    const [pid,pgid,tty,state] = row.trim().split(/\\s+/)
    return {pid:Number(pid),pgid:Number(pgid),tty,state}
  }).filter(row => row.pid > 0 && row.state)
  const root = table.find(row => row.pid === proc.pid)
  // BusyBox discovery returns all processes; this probe owns only its shell's terminal.
  return root ? table.filter(row => row.tty === root.tty) : []
}
const waitFor = async predicate => {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await Bun.sleep(20)
  }
  throw new Error('Timed out waiting for terminal process state')
}
;(async()=>{
  try {
    proc.write('/bin/bash sleeper.sh\\r')
    // A forked PID can appear before Bash gives its group the foreground terminal.
    const sleeperPid = await waitFor(() => existsSync(ready) && Number(readFileSync(ready, 'utf8')))
    const sleeper = await waitFor(async () => (await rows()).find(row => row.pid === sleeperPid))
    proc.write('\\x1a')
    await waitFor(async () => (await rows()).some(row => row.pid === sleeper.pid && row.state.startsWith('T')))
    proc.write(${JSON.stringify('"$ORCA_TEST_RUNTIME" producer.cjs &\r')})
    await waitFor(() => output.split('flow-tick').length > 5)
    proc.pause()
    await waitFor(() => signals.filter(([,signal]) => signal === 'SIGSTOP').length >= 2)
    await Bun.sleep(100)
    const pausedLength = output.length
    await Bun.sleep(100)
    const producerPaused = pausedLength === output.length
    proc.resume()
    await waitFor(() => signals.some(([,signal]) => signal === 'SIGCONT'))
    await waitFor(() => output.length > pausedLength)
    const sleeperAfter = (await rows()).find(row => row.pid === sleeper.pid)
    console.log(JSON.stringify({producerPaused,producerResumed:true,userJobStopped:sleeperAfter?.state.startsWith('T')===true,userJobSignalled:signals.some(([pgid])=>pgid===sleeper.pgid)}))
  } finally {
    let ownedPids = []
    try {
      proc.resume()
      const ownedRows = await rows()
      ownedPids = ownedRows.map(row => row.pid)
      const root = ownedRows.find(row => row.pid === proc.pid)
      if (!root) throw new Error('Cleanup could not find the owned shell')
      // Keep Bash running until it reaps its jobs; container PID 1 may not reap orphans.
      forceKillPosixPtyProcessGroups(proc.pid, () => {throw new Error('Cleanup lost terminal ownership')}, {
        signalProcessGroup: pgid => {if (pgid !== root.pgid) process.kill(-pgid, 'SIGKILL')}
      })
      process.kill(proc.pid, 'SIGCONT')
      await waitFor(() => ownedPids.every(pid => pid === proc.pid || !isAlive(pid)))
    } finally {
      try {
        forceKillPosixPtyProcessGroups(proc.pid, () => proc.kill('SIGKILL'))
        await waitFor(() => exited && ownedPids.every(pid => !isAlive(pid)))
      } finally {
        proc.destroy()
      }
    }
  }
})().catch(error => {console.error(error);process.exitCode=1})
`
      )
      const result = await runProcess({ program: runtimePath, args: [entry], timeoutMs: 25_000 })
      expect(result.timedOut).toBe(false)
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({
        producerPaused: true,
        producerResumed: true,
        userJobStopped: true,
        userJobSignalled: false
      })
    } finally {
      removeTreeSync(directory)
    }
  })
})

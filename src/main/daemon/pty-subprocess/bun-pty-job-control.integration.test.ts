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
  it('keeps a real Ctrl-Z job suspended while pausing and resuming a background producer', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-bun-job-control-'))
    try {
      writeFileSync(join(directory, 'producer.cjs'), 'setInterval(()=>console.log("flow-tick"),10)')
      const entry = join(directory, 'job-control.cjs')
      writeFileSync(
        entry,
        `
const {spawnBunPty} = require(${JSON.stringify(join(__dirname, 'bun-pty-process.ts'))})
const {readPosixPtyProcessTable} = require(${JSON.stringify(join(__dirname, '../../pty/posix-pty-process-groups.ts'))})
const signals = []
const proc = spawnBunPty({
  file:'/bin/bash', args:['--noprofile','--norc','-i'], cwd:${JSON.stringify(directory)},
  env:{...process.env,PS1:'',ORCA_TEST_RUNTIME:process.execPath},cols:80,rows:24
}, {signalProcessGroup:(pgid,signal)=>{process.kill(-pgid,signal);signals.push([pgid,signal])}})
let output = ''
proc.onData(data => output += data)
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
    proc.write('sleep 30\\r')
    const sleeper = await waitFor(async () => (await rows()).find(row => row.pid !== proc.pid))
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
    proc.kill('SIGKILL')
    proc.destroy()
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

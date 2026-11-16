import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

type Identity = { pid: number; start: string; parent: number; group: number }
type Exit = { code: number | null; signal: string | null }

function identity(pid: number): Identity | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/)
    const start = fields[19]
    if (!start || !/^\d+$/.test(start)) {
      throw new Error(`Invalid process identity for ${pid}`)
    }
    return { pid, start, parent: Number(fields[1]), group: Number(fields[2]) }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

function stillOwned(owner: Identity): boolean {
  const current = identity(owner.pid)
  return current?.start === owner.start && current.group === owner.group
}

function terminate(pid: number, signal: 'SIGTERM' | 'SIGKILL') {
  try {
    process.kill(pid, signal)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
      throw error
    }
  }
}

export function startServeSignalProcess(bash: string, script: string, command: string) {
  // A separate group contains the served shell and its sleeps when an assertion fails.
  const child = spawn(bash, ['-c', script, 'init', bash, '-c', command], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let exit: Exit | undefined
  let failure: Error | undefined
  let closed = false
  let stdout = ''
  let stderr = ''
  let served: Identity | null = null
  let supervisor: Identity | null = null
  let mask = 'unobserved'
  const onError = (error: Error) => {
    failure = error
  }
  const onExit = (code: number | null, signal: string | null) => {
    exit = { code, signal }
  }
  const onClose = () => {
    closed = true
  }
  const onStdout = (chunk: string) => {
    stdout += chunk
    const record = stdout.match(/(?:^|\n)ready:([1-9][0-9]*)\n/)
    if (!served && supervisor && record) {
      try {
        const observed = identity(Number(record[1]))
        if (observed?.parent === supervisor.pid && observed.group === supervisor.group) {
          served = observed
        }
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error))
      }
    }
  }
  const onStderr = (chunk: string) => {
    stderr += chunk
  }
  child.on('error', onError)
  child.on('exit', onExit)
  child.on('close', onClose)
  child.stdout.setEncoding('utf8').on('data', onStdout)
  child.stderr.setEncoding('utf8').on('data', onStderr)
  try {
    supervisor = child.pid ? identity(child.pid) : null
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error))
  }

  function diagnostic(phase: string): Error {
    return new Error(
      `${phase}; pid=${child.pid}, SigCgt=${mask}, exit=${JSON.stringify(exit)}, stdout=${JSON.stringify(stdout)}, stderr=${JSON.stringify(stderr)}`
    )
  }

  async function until(ready: () => boolean, phase: string, deadline: number) {
    while (!ready()) {
      if (failure) {
        throw failure
      }
      if (stdout.length + stderr.length > 64 * 1024 || Date.now() >= deadline) {
        throw diagnostic(phase)
      }
      await delay(10)
    }
  }

  return {
    async ready(signal: 'SIGINT' | 'SIGTERM', deadline: number) {
      if (!supervisor || supervisor.group !== supervisor.pid) {
        throw diagnostic('No owned supervisor process group')
      }
      const caughtBit = signal === 'SIGTERM' ? 1n << 14n : 1n << 1n
      await until(
        () => {
          if (exit || !supervisor || !stillOwned(supervisor)) {
            throw diagnostic('Supervisor exited before readiness')
          }
          if (!served) {
            const record = stdout.match(/(?:^|\n)ready:([1-9][0-9]*)\n/)
            if (!record) {
              return false
            }
            served = identity(Number(record[1]))
            if (!served || served.parent !== supervisor.pid || served.group !== supervisor.group) {
              throw diagnostic('Readiness did not identify the served child')
            }
          }
          if (!stillOwned(served)) {
            throw diagnostic('Served child exited before readiness')
          }
          const status = readFileSync(`/proc/${supervisor.pid}/status`, 'utf8')
          mask = status.match(/^SigCgt:\s*([0-9a-f]+)$/im)?.[1] ?? ''
          if (!mask) {
            throw diagnostic('Missing supervisor caught-signal mask')
          }
          return (BigInt(`0x${mask}`) & caughtBit) !== 0n
        },
        'Timed out waiting for served child and supervisor signal handler',
        deadline
      )
    },
    async signalAndWait(signal: 'SIGINT' | 'SIGTERM', deadline: number) {
      if (!supervisor || !stillOwned(supervisor) || !child.kill(signal)) {
        throw diagnostic('Could not signal the owned supervisor')
      }
      await until(
        () => exit !== undefined && closed,
        'Timed out waiting for forwarding/exit',
        deadline
      )
      return { exit, stdout }
    },
    async dispose() {
      try {
        if (served && stillOwned(served)) {
          terminate(served.pid, 'SIGTERM')
        }
        const grace = Date.now() + 250
        while (!closed && Date.now() < grace) {
          await delay(10)
        }
        const owner = [supervisor, served].find((entry) => entry && stillOwned(entry))
        if (owner) {
          terminate(-owner.group, 'SIGKILL')
        } else if (!supervisor && !closed) {
          child.kill('SIGKILL')
        }
        await until(() => closed, 'Cleanup did not close owned process streams', Date.now() + 2000)
        for (const entry of [supervisor, served]) {
          if (entry && stillOwned(entry)) {
            throw diagnostic(`Cleanup left owned process ${entry.pid}`)
          }
        }
      } finally {
        child.removeListener('error', onError)
        child.removeListener('exit', onExit)
        child.removeListener('close', onClose)
        child.stdout.removeListener('data', onStdout)
        child.stderr.removeListener('data', onStderr)
      }
    }
  }
}

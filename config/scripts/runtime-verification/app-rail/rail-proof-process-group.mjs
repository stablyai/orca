import { execFile, execFileSync, fork } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

const SIGNAL_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }
const exec = promisify(execFile)
const CLOSE_TIMEOUT = 10_000

export function log(line) {
  console.log(`[rail-proof] ${line}`)
}

async function groupMembers(group) {
  try {
    const { stdout } = await exec(
      process.env.ORCA_RAIL_PROOF_PGREP || 'pgrep',
      ['-g', String(group)],
      { timeout: 2_000, killSignal: 'SIGKILL' }
    )
    const members = stdout.trim().split(/\s+/).map(Number)
    if (members.some((pid) => !Number.isSafeInteger(pid) || pid < 1)) {
      throw new Error('invalid process inventory')
    }
    return members
  } catch (error) {
    if (error.code === 1 && !error.signal) {
      return []
    }
    throw error
  }
}

function childExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}

function message(child, value) {
  if (child.connected) {
    child.send(value, () => {})
  }
}

async function waitForEmptyGroup(group, exclude) {
  const deadline = performance.now() + CLOSE_TIMEOUT
  let members
  do {
    members = (await groupMembers(group)).filter((pid) => pid !== exclude)
    if (members.length === 0) {
      break
    }
    await delay(100)
  } while (performance.now() < deadline)
  return members
}

// A detached supervisor anchors the group. Only it can signal the group, using kernel membership (kill(0)),
// even if a child is reparented or an old group number appears again after exit. The outer CLI only observes.
async function supervise(proof, args) {
  if (!process.connected) {
    throw new Error('The rail proof supervisor must be started by its CLI.')
  }
  const group = execFileSync('ps', ['-p', String(process.pid), '-o', 'pgid='], {
    encoding: 'utf8',
    timeout: 2_000
  })
  if (Number(group.trim()) !== process.pid) {
    throw new Error('The rail proof supervisor does not own its process group.')
  }
  const worker = fork(proof, args, { env: { ...process.env, ORCA_RAIL_PROOF_WORKER: '1' } })
  log(`proof group ${process.pid}, worker pid ${worker.pid}`)
  let timer
  let cleaning = false
  let escalated = false
  const forward = (signal) => {
    if (!cleaning && !timer) {
      message(worker, { signal })
      timer = setTimeout(() => forceCleanup('worker exceeded its cancellation deadline', 1), 25_000)
    }
  }
  process.on('message', ({ signal }) => forward(signal))
  process.on('disconnect', () => forward('SIGTERM'))
  for (const signal of Object.keys(SIGNAL_CODES)) {
    process.on(signal, () => forward(signal))
  }

  function forceCleanup(reason, code) {
    if (escalated) {
      return
    }
    escalated = true
    log(`teardown: ${reason}; SIGKILL to invocation group ${process.pid}`)
    const kill = () => process.kill(0, 'SIGKILL')
    if (process.connected) {
      process.send({ code, killedGroup: true }, kill)
    } else {
      kill()
    }
  }

  let code = 1
  try {
    const exit = await childExit(worker)
    log(
      `teardown: worker pid ${worker.pid} exited code ${exit.code}, signal ${exit.signal ?? 'none'}`
    )
    code = exit.code ?? 1
  } catch (error) {
    console.error(error)
  } finally {
    cleaning = true
    clearTimeout(timer)
  }
  if (escalated) {
    return
  }

  try {
    const members = (await groupMembers(process.pid)).filter((pid) => pid !== process.pid)
    if (members.length > 0) {
      log(`teardown: SIGTERM to invocation group ${process.pid}; members [${members.join(', ')}]`)
      process.kill(0, 'SIGTERM')
      const remaining = await waitForEmptyGroup(process.pid, process.pid)
      if (remaining.length > 0) {
        forceCleanup(`surviving members [${remaining.join(', ')}]`, code)
        return
      }
    }
  } catch (error) {
    forceCleanup(`process inventory failed: ${error.message}`, 1)
    return
  }
  process.exitCode = code
  if (process.connected) {
    process.disconnect()
  }
}

export async function runInProofProcessGroup() {
  if (!['darwin', 'linux'].includes(process.platform)) {
    throw new Error('Rail runtime proofs require Unix process groups (macOS or Linux).')
  }
  let requestedSignal
  let supervisor
  for (const signal of Object.keys(SIGNAL_CODES)) {
    process.on(signal, () => {
      if (!requestedSignal) {
        requestedSignal = signal
        log(`received ${signal}; waiting for proof teardown`)
        if (supervisor) {
          message(supervisor, { signal })
        }
      }
    })
  }
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'orca-rail-proof-'))
  let code = 1
  try {
    if (requestedSignal) {
      code = SIGNAL_CODES[requestedSignal]
      return
    }
    supervisor = fork(import.meta.filename, process.argv.slice(1), {
      detached: true,
      env: { ...process.env, ORCA_RAIL_PROOF_TEMP: tempDir }
    })
    let forcedExit
    supervisor.on('message', ({ code: status, killedGroup }) => {
      if (killedGroup) {
        forcedExit = status
      }
    })
    if (requestedSignal) {
      message(supervisor, { signal: requestedSignal })
    }
    const exit = await childExit(supervisor)
    log(
      `teardown: supervisor pid ${supervisor.pid} exited code ${exit.code}, signal ${exit.signal ?? 'none'}`
    )
    const surviving = await waitForEmptyGroup(supervisor.pid)
    if (surviving.length) {
      throw new Error(`process group ${supervisor.pid} still has members [${surviving.join(', ')}]`)
    }
    log(`teardown: invocation group ${supervisor.pid} empty`)
    code = (exit.signal === 'SIGKILL' ? forcedExit : exit.code) ?? 1
    if (requestedSignal && code === 0) {
      code = SIGNAL_CODES[requestedSignal]
    }
  } catch (error) {
    console.error(error)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
    log(`exit status ${code}`)
    process.exitCode = code
  }
}

if (process.argv[1] === import.meta.filename) {
  await supervise(process.argv[2], process.argv.slice(3))
}

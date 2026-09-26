const assert = require('node:assert/strict')
const fs = require('node:fs')
const { join } = require('node:path')
const { spawn, execFileSync } = require('node:child_process')

const [bundlePath, mode] = process.argv.slice(2)
assert.ok(['baseline', 'candidate'].includes(mode))
const fixture = join(__dirname, 'process-fixture.cjs')
const prefix = `retention-${mode}-${process.pid}-${Date.now()}`
const scopes = []
const workers = []
const cgroups = []
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function stat(pid) {
  try {
    const contents = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = contents.slice(contents.lastIndexOf(') ') + 2).split(' ')
    return fields[0] === 'Z'
      ? null
      : { ppid: Number(fields[1]), pgid: Number(fields[2]), startTicks: fields[19] }
  } catch {
    return null
  }
}

function rss(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8')
    return Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0)
  } catch {
    return 0
  }
}

async function until(predicate, message, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await delay(25)
  }
  throw new Error(message)
}

function readPid(path) {
  return fs.existsSync(path) ? Number(fs.readFileSync(path, 'utf8')) : null
}

function scopePath(pid) {
  return fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim()
}

async function startCycle(cycle, ownership = 'exclusive') {
  const nonce = `${prefix}-${cycle}`
  const resultPath = `/tmp/${nonce}`
  const unit = `orca-daemon-${nonce}.scope`
  scopes.push(unit)
  const runtime = spawn(
    process.execPath,
    [fixture, 'runtime', resultPath, bundlePath, nonce, ownership],
    { stdio: 'inherit' }
  )
  await new Promise((resolve, reject) => {
    runtime.on('error', reject)
    runtime.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`runtime exited ${code}`))
    )
  })
  let workerPid, daemonPid
  await until(() => {
    workerPid = readPid(resultPath)
    daemonPid = readPid(`${resultPath}.daemon`)
    return workerPid && daemonPid && stat(workerPid)?.ppid === 1
  }, 'worker did not reparent before daemon stop')
  assert.ok(stat(daemonPid), 'daemon did not survive its runtime exit')
  assert.equal(scopePath(workerPid), scopePath(daemonPid), 'worker escaped its owning scope')
  assert.ok(scopePath(workerPid).endsWith(unit), 'daemon did not enter requested scope')
  const cgroupDirectory = join('/sys/fs/cgroup', scopePath(workerPid).split(':').slice(2).join(':'))
  assert.ok(
    fs.existsSync(join(cgroupDirectory, 'memory.current')),
    'cgroup memory accounting missing'
  )
  await delay(300)
  assert.ok(stat(daemonPid) && stat(workerPid), 'runtime exit killed terminal work')
  return { workerPid, daemonPid, resultPath, unit, cgroupDirectory }
}

async function main() {
  const canaryUnit = `orca-canary-${prefix}.scope`
  scopes.push(canaryUnit)
  const canary = spawn(
    'systemd-run',
    [
      '--user',
      '--scope',
      '--collect',
      '--quiet',
      `--unit=${canaryUnit}`,
      '--',
      '/bin/sleep',
      '120'
    ],
    { stdio: 'inherit' }
  )
  try {
    await until(
      () => stat(canary.pid) && scopePath(canary.pid).endsWith(canaryUnit),
      'canary scope missing'
    )
    for (const [index, signal] of [
      'SIGTERM',
      'SIGKILL',
      'natural-exit',
      'process-group-SIGKILL'
    ].entries()) {
      const cycle = index + 1
      const { workerPid, daemonPid, resultPath, cgroupDirectory } = await startCycle(cycle)
      workers.push(workerPid)
      cgroups.push(cgroupDirectory)
      if (signal === 'natural-exit') {
        fs.writeFileSync(`${resultPath}.exit`, '')
      } else if (signal === 'process-group-SIGKILL') {
        assert.equal(stat(daemonPid)?.pgid, daemonPid, 'daemon does not own its process group')
        process.kill(-daemonPid, 'SIGKILL')
      } else {
        process.kill(daemonPid, signal)
      }
      await until(() => !stat(daemonPid), 'daemon did not exit')
      await (mode === 'candidate'
        ? until(() => !stat(workerPid), 'scope retained orphan after daemon exit', 12000)
        : delay(700))
      if (mode === 'candidate') {
        await until(
          () => !fs.existsSync(cgroupDirectory),
          'scope retained a process after worker exit'
        )
      }
      const live = workers.filter((pid) => stat(pid))
      const retainedRssKiB = live.reduce((sum, pid) => sum + rss(pid), 0)
      const retainedCgroupMemoryKiB = cgroups.reduce((sum, directory) => {
        const memoryFile = join(directory, 'memory.current')
        return (
          sum + (fs.existsSync(memoryFile) ? Number(fs.readFileSync(memoryFile, 'utf8')) / 1024 : 0)
        )
      }, 0)
      assert.equal(live.length, mode === 'baseline' ? cycle : 0)
      assert.ok(stat(canary.pid), 'unrelated scope was killed')
      console.log(
        JSON.stringify({
          mode,
          cycle,
          signal,
          liveWorkers: live.length,
          retainedRssKiB,
          retainedCgroupMemoryKiB,
          unrelatedCanary: 'live',
          runtimeExitPreservedDaemon: true,
          workerReparentedBeforeStop: true
        })
      )
    }
    if (mode === 'candidate') {
      const { workerPid, daemonPid } = await startCycle('shared', 'shared')
      process.kill(daemonPid, 'SIGKILL')
      await until(() => !stat(daemonPid), 'shared-scope daemon did not exit')
      await delay(700)
      assert.ok(stat(workerPid), 'scope without exclusive ownership was stopped')
      assert.ok(stat(canary.pid), 'unrelated canary was killed')
      console.log(
        JSON.stringify({ mode, sharedScopeWithoutOwnership: 'preserved', unrelatedCanary: 'live' })
      )
      const brokenPipe = await startCycle('broken-pipe', 'broken-pipe')
      await delay(5700)
      assert.ok(stat(brokenPipe.daemonPid), 'premature pipe closure killed the daemon')
      assert.ok(stat(brokenPipe.workerPid), 'premature pipe closure killed live terminal work')
      assert.ok(stat(canary.pid), 'unrelated canary was killed')
      console.log(
        JSON.stringify({
          mode,
          prematurePipeClosure: 'live-work-preserved',
          unrelatedCanary: 'live'
        })
      )
    }
  } finally {
    for (const unit of scopes) {
      try {
        execFileSync('systemctl', ['--user', '--signal=SIGKILL', 'kill', unit], { stdio: 'ignore' })
      } catch {}
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

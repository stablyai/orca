// Exercise terminal isolation against real systemd: OOM/fork limits spare daemon/neighbors, while daemon exit ends the terminal slice. Baseline reports shared-scope OOM behavior.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { join } = require('node:path')
const { spawn, execFileSync } = require('node:child_process')

const fixture = join(__dirname, 'process-fixture.cjs')
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const alive = (pid) => {
  try {
    return !fs.readFileSync(`/proc/${pid}/stat`, 'utf8').includes(') Z ')
  } catch {
    return false
  }
}
const cgroupOf = (pid) =>
  fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').trim().split('\n').at(-1).replace(/^0::/, '')
const cgroupFile = (cgroup, name) => fs.readFileSync(join('/sys/fs/cgroup', cgroup, name), 'utf8')
const pidFrom = (path) => (fs.existsSync(path) ? Number(fs.readFileSync(path, 'utf8')) : null)
const systemctl = (...args) =>
  execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8' }).trim()

async function until(predicate, message, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await delay(50)
  }
  throw new Error(message)
}

async function startDaemon(bundlePath, nonce, terminals, env = {}, mode = 'candidate') {
  const resultPath = `/tmp/${nonce}`
  const runtime = spawn(
    process.execPath,
    [fixture, 'runtime', resultPath, bundlePath, nonce, 'terminals'],
    {
      stdio: 'inherit',
      env: { ...process.env, ...env, ORCA_FIXTURE_TERMINALS: JSON.stringify(terminals) }
    }
  )
  await new Promise((resolve) => runtime.on('exit', resolve))
  await until(() => fs.existsSync(`${resultPath}.daemon`), 'terminal daemon did not start')
  const daemon = JSON.parse(fs.readFileSync(`${resultPath}.daemon`, 'utf8'))
  const unit = `orca-daemon-${nonce}.scope`
  assert.ok(cgroupOf(daemon.pid).endsWith(`/${unit}`), 'daemon is not in its own scope')
  if (mode === 'baseline') {
    return { ...daemon, unit }
  }
  // systemd-run moves itself into the scope before it execs the shell.
  await until(
    () => daemon.terminals.every((pid) => /\/orca_pty_[^/]+\.scope$/.test(cgroupOf(pid))),
    `terminals never entered their scopes: ${JSON.stringify(daemon.events)}`
  )
  const scopes = daemon.terminals.map(cgroupOf)
  const slice = scopes[0].split('/').slice(0, -1).join('/')
  assert.equal(new Set(scopes).size, scopes.length, 'two terminals share a scope')
  for (const scope of scopes) {
    assert.match(scope, /\/orca_ptys_[^/]+\.slice\/orca_pty_[^/]+\.scope$/)
    assert.ok(scope.startsWith(`${slice}/`), 'terminal scopes are not siblings in one slice')
  }
  assert.ok(!slice.includes(unit), 'terminal slice is nested in the daemon scope')
  // Without delegated controllers the OOM and fork cases prove nothing.
  assert.match(cgroupFile(slice, 'cgroup.controllers'), /\bmemory\b.*\bpids\b|\bpids\b.*\bmemory\b/)
  return { ...daemon, resultPath, unit, slice, sliceUnit: slice.split('/').at(-1), scopes }
}

async function expectReaped(daemon, extraPids) {
  await until(
    () => [daemon.pid, ...daemon.terminals, ...extraPids].every((pid) => !alive(pid)),
    'terminal processes outlived the daemon scope'
  )
  await until(
    () => !fs.existsSync(join('/sys/fs/cgroup', daemon.slice)),
    'terminal slice outlived the daemon scope'
  )
}

async function oomCase(bundlePath, prefix, systemdVersion, mode) {
  const r = `/tmp/${prefix}-oom`
  const hog = 'const a = []; for (;;) a.push(Buffer.alloc(1 << 20, 1))'
  const daemon = await startDaemon(
    bundlePath,
    `${prefix}-oom`,
    [
      // Ignores SIGTERM and SIGHUP, so only the scope stop's SIGKILL can end it.
      `(trap '' TERM HUP; exec sleep 600) & echo $! > ${r}.stubborn; exec sleep 600`,
      `sleep 600 & echo $! > ${r}.sleeper; while [ ! -f ${r}.go ]; do sleep 0.05; done; ` +
        `${process.execPath} -e '${hog}'; echo $? > ${r}.hog-exit; wait`,
      'exec sleep 600'
    ],
    {},
    mode
  )
  const properties = daemon.events?.find((entry) => entry.event === 'terminal-scopes').properties
  const continuePolicy = properties?.includes('OOMPolicy=continue') === true
  const [term1, term2, term3] = daemon.terminals
  await until(() => pidFrom(`${r}.sleeper`) && pidFrom(`${r}.stubborn`), 'terminals not ready')
  const sleeper = pidFrom(`${r}.sleeper`)
  // Baseline terminals share the daemon scope, so only its limit can be hit.
  const [limited, memoryMax] =
    mode === 'baseline' ? [daemon.unit, '192M'] : [daemon.scopes[1].split('/').at(-1), '64M']
  systemctl('set-property', '--runtime', limited, `MemoryMax=${memoryMax}`, 'MemorySwapMax=0')
  fs.writeFileSync(`${r}.go`, '')
  await until(() => fs.existsSync(`${r}.hog-exit`) || !alive(term2), 'hog was not OOM-killed')
  await delay(500)
  const terminal2 = alive(term2) && alive(sleeper) ? 'hog-only' : 'whole-terminal'
  if (mode === 'baseline') {
    const daemonState = alive(daemon.pid) ? 'live' : 'killed'
    const neighbours = alive(term1) && alive(term3) ? 'live' : 'killed'
    console.log(JSON.stringify({ mode, systemdVersion, daemon: daemonState, neighbours }))
    try {
      systemctl('stop', daemon.unit)
    } catch {
      // The OOM stop already ended the scope, and --collect may have unloaded it.
    }
    return
  }
  // Without OOMPolicy, systemd's own policy decides terminal 2's fate; neighbours never share it.
  if (continuePolicy) {
    assert.equal(terminal2, 'hog-only', 'OOMPolicy=continue still stopped terminal 2')
  }
  assert.ok(alive(daemon.pid), 'an OOM kill in terminal 2 killed the daemon')
  assert.ok(alive(term1) && alive(term3), 'an OOM kill in terminal 2 killed its neighbours')
  console.log(
    JSON.stringify({
      systemdVersion,
      oomPolicyContinue: continuePolicy,
      oomInTerminal2: terminal2,
      daemon: 'live',
      terminals1And3: 'live'
    })
  )
  const stubborn = pidFrom(`${r}.stubborn`)
  systemctl('stop', daemon.unit)
  await expectReaped(daemon, [sleeper, stubborn])
  console.log(JSON.stringify({ daemonScopeStopped: 'slice-and-terminals-reaped' }))
}

async function ceilingCase(bundlePath, prefix) {
  const r = `/tmp/${prefix}-ceiling`
  const daemon = await startDaemon(
    bundlePath,
    `${prefix}-ceiling`,
    [
      // The shell exits at the first refused fork; its children keep the scope at the limit.
      `while [ ! -f ${r}.bomb ]; do sleep 0.05; done; ` +
        'i=0; while [ $i -lt 100 ]; do sleep 600 & i=$((i + 1)); done; wait',
      `while [ ! -f ${r}.go ]; do sleep 0.05; done; for i in 1 2 3 4 5; do sleep 600 & done; ` +
        `echo ok > ${r}.forked; wait`
    ],
    { ORCA_TERMINAL_PROCESS_CEILING: '64' }
  )
  assert.equal(daemon.ceiling.state, 'on', JSON.stringify(daemon.ceiling))
  const [forkBomb, neighbour] = daemon.scopes
  for (const scope of daemon.scopes) {
    assert.equal(cgroupFile(scope, 'pids.max').trim(), '64')
  }
  fs.writeFileSync(`${r}.bomb`, '')
  await until(
    () => /^max [1-9]/m.test(cgroupFile(forkBomb, 'pids.events')),
    'terminal 1 never reached its own limit'
  )
  fs.writeFileSync(`${r}.go`, '')
  await until(() => fs.existsSync(`${r}.forked`), 'terminal 2 could not fork beside terminal 1')
  assert.match(cgroupFile(neighbour, 'pids.events'), /^max 0$/m)
  assert.ok(alive(daemon.pid), 'the fork limit in terminal 1 starved the daemon')
  console.log(JSON.stringify({ ceilingPerTerminal: 64, terminal1: 'at-limit', terminal2: 'forks' }))
  const descendants = fs
    .readFileSync(join('/sys/fs/cgroup', neighbour, 'cgroup.procs'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(Number)
  process.kill(daemon.pid, 'SIGKILL')
  await expectReaped(daemon, descendants)
  console.log(JSON.stringify({ daemonSigkill: 'slice-and-terminals-reaped' }))
}

async function runTerminalScopeCases(bundlePath, prefix, mode) {
  const systemdVersion = Number(
    execFileSync('systemctl', ['--version'], { encoding: 'utf8' }).match(/^systemd (\d+)/)[1]
  )
  await oomCase(bundlePath, prefix, systemdVersion, mode)
  if (mode === 'candidate') {
    await ceilingCase(bundlePath, prefix)
  }
}

module.exports = { runTerminalScopeCases }

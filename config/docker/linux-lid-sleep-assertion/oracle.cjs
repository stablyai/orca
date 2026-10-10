const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { readFileSync, rmSync } = require('node:fs')
const { join, dirname } = require('node:path')

const [mode, bundle] = process.argv.slice(2)
assert(['baseline', 'candidate'].includes(mode))
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(check, label) {
  const deadline = Date.now() + 5000
  do {
    if (check()) {
      return
    }
    await pause(50)
  } while (Date.now() < deadline)
  throw new Error(`Timed out: ${label}`)
}

function live(pid) {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(')').at(-1).trim()[0] !== 'Z'
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

function children(pid) {
  return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
}

function ownsInhibitor(pid) {
  const result = JSON.parse(
    execFileSync(
      'busctl',
      [
        '--json=short',
        'call',
        'org.freedesktop.login1',
        '/org/freedesktop/login1',
        'org.freedesktop.login1.Manager',
        'ListInhibitors'
      ],
      { encoding: 'utf8' }
    )
  )
  return result.data[0].some((row) => row.at(-1) === pid && row[0] === 'sleep:handle-lid-switch')
}

function scopeActive(unit) {
  return (
    execFileSync('systemctl', ['show', unit, '--property=ActiveState', '--value'], {
      encoding: 'utf8'
    }).trim() === 'active'
  )
}

function kill(pid) {
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    if (error.code !== 'ESRCH') {
      throw error
    }
  }
}

async function runScenario(scenario) {
  const unit = `app-orca-inhibitor-oracle-${randomUUID()}.scope`
  const identityFile = join('/tmp', `${unit}.pid`)
  const owner = spawn(
    'systemd-run',
    [
      '--scope',
      `--unit=${unit}`,
      '--collect',
      '--quiet',
      '--',
      process.execPath,
      join(dirname(bundle), 'owner.cjs'),
      bundle,
      identityFile
    ],
    { stdio: ['pipe', 'ignore', 'inherit'] }
  )
  owner.stdin.on('error', () => {})
  const canary = spawn('sleep', ['60'], { stdio: 'ignore' })
  let ownerPid
  let inhibitorPid
  let holderPids = []
  try {
    await until(() => {
      try {
        ownerPid = Number(readFileSync(identityFile, 'utf8'))
        return ownerPid > 0
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error
        }
        return false
      }
    }, 'production assertion owner started')
    await until(() => {
      inhibitorPid = children(ownerPid)[0]
      return inhibitorPid > 0 && ownsInhibitor(inhibitorPid)
    }, 'sleep and lid-switch lock held')
    await until(() => {
      holderPids = children(inhibitorPid)
      return holderPids.length > 0
    }, 'holder started')
    await pause(250)
    assert(live(ownerPid) && live(inhibitorPid) && holderPids.every(live))
    assert(ownsInhibitor(inhibitorPid), 'lock must remain held while owner is alive')

    if (scenario === 'stop') {
      owner.stdin.write('stop\n')
    } else {
      kill(ownerPid)
    }

    if (mode === 'baseline') {
      await pause(300)
      assert(
        live(inhibitorPid) && holderPids.every(live),
        'baseline must reproduce both orphan processes'
      )
      assert(ownsInhibitor(inhibitorPid), 'baseline must retain the leaked sleep lock')
      assert(scopeActive(unit), 'baseline must retain the leaked app scope')
    } else {
      await until(
        () => !live(inhibitorPid) && holderPids.every((pid) => !live(pid)),
        'inhibitor and holder exited'
      )
      assert(!ownsInhibitor(inhibitorPid), 'sleep lock must be released')
      if (scenario === 'stop') {
        assert(live(ownerPid), 'releasing the lock must leave the app alive')
        kill(ownerPid)
      }
      await until(() => !scopeActive(unit), 'app scope collected after owner exit')
    }
    assert(live(canary.pid), 'unrelated process must survive')
    console.log(
      JSON.stringify({
        mode,
        scenario,
        holder: mode === 'baseline' ? 'live' : 'exited',
        inhibitor: mode === 'baseline' ? 'held' : 'released',
        scope: mode === 'baseline' ? 'active' : 'collected',
        canary: 'live'
      })
    )
  } finally {
    for (const pid of [...holderPids, inhibitorPid, ownerPid ?? owner.pid, canary.pid].filter(
      Boolean
    )) {
      kill(pid)
    }
    owner.stdin.destroy()
    rmSync(identityFile, { force: true })
  }
}

;(async () => {
  await runScenario('crash')
  if (mode === 'candidate') {
    await runScenario('stop')
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

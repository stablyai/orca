#!/usr/bin/env node
// Installs a server-only tarball the documented way, starts `orca serve --recipe-json`, then pairs a
// second CLI profile with the printed code. Uses only node: builtins so the archive's own Node can run it
// on an image that has nothing else.
//   node smoke-orcad-server-artifact.mjs --archive out/orca-server/orca-server-linux-x64.tar.gz
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const archiveArg = argv[argv.indexOf('--archive') + 1]
if (!argv.includes('--archive') || !archiveArg) {
  fail('Usage: smoke-orcad-server-artifact.mjs --archive <orca-server-*.tar.gz>')
}
const archive = resolve(archiveArg)
const work = mkdtempSync(join(tmpdir(), 'orca-server-smoke-'))
const install = join(work, 'install')
const projectRoot = join(work, 'project')
const serverProfile = join(work, 'server-profile')
const clientProfile = join(work, 'client-profile')
// Linux names the CLI orca-ide, like the desktop package.
const orca = join(install, 'bin', 'orca-ide')

try {
  verifyChecksum()
  for (const dir of [install, projectRoot, serverProfile, clientProfile]) {
    mkdirSync(dir, { recursive: true })
  }
  execFileSync('tar', ['-xzf', archive, '-C', install, '--strip-components=1'], {
    stdio: 'inherit'
  })
  const version = run([orca, '--version'], serverProfile)
  assert(version.status === 0, `orca --version failed:\n${version.stderr}`)
  console.log(`installed ${version.stdout.trim()}`)

  const started = Date.now()
  const serve = run(
    [orca, 'serve', '--recipe-json', '--project-root', projectRoot, '--port', '0'],
    serverProfile,
    { timeout: 120_000 }
  )
  assert(serve.status === 0, `serve --recipe-json exited ${serve.status}:\n${serve.stderr}`)
  const recipe = JSON.parse(serve.stdout.trim().split('\n').at(-1))
  const pairingCode = recipe.pairingCode ?? recipe.connection?.pairingCode
  assert(
    typeof pairingCode === 'string' && pairingCode.length > 0,
    `no pairing code: ${serve.stdout}`
  )
  assert(
    (recipe.projectRoot ?? recipe.connection?.projectRoot) === projectRoot,
    `recipe JSON names another project root: ${serve.stdout}`
  )
  console.log(`PASS serve --recipe-json printed a pairing code in ${Date.now() - started} ms`)

  const status = run([orca, '--pairing-code', pairingCode, 'status', '--json'], clientProfile, {
    timeout: 60_000
  })
  assert(status.status === 0, `paired status failed:\n${status.stderr}\n${status.stdout}`)
  const result = JSON.parse(status.stdout).result ?? {}
  assert(
    result.runtime?.state === 'ready' && result.runtime?.reachable !== false,
    `paired client did not reach a ready server: ${status.stdout}`
  )
  console.log(
    `PASS a second profile paired and saw runtime ${result.runtime.runtimeId ?? ''} ready`
  )
} finally {
  stopServersFrom(install)
  rmSync(work, { recursive: true, force: true })
}

function verifyChecksum() {
  const sums = `${archive}.sha256`
  if (!existsSync(sums)) {
    return
  }
  const [expected, name] = readFileSync(sums, 'utf8').trim().split(/\s+/)
  const actual = createHash('sha256').update(readFileSync(archive)).digest('hex')
  assert(name === basename(archive) && actual === expected, `${archive} does not match ${sums}`)
  console.log('PASS checksum')
}

// stderr goes to a file: the detached server keeps it open, and a pipe would hold spawnSync until timeout.
function run(command, profile, { timeout = 30_000 } = {}) {
  const [program, ...args] = command
  const log = join(work, `${basename(profile)}.stderr.log`)
  const fd = openSync(log, 'a')
  try {
    const result = spawnSync(program, args, {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', fd],
      env: { ...process.env, ORCA_USER_DATA_PATH: profile, ORCA_BACKGROUND_LAUNCH: '1' }
    })
    return { ...result, stderr: readFileSync(log, 'utf8').slice(-4000) }
  } finally {
    closeSync(fd)
  }
}

// --recipe-json leaves the server running on purpose; this smoke must not.
function stopServersFrom(dir) {
  const listing = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' })
  for (const line of (listing.stdout ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (match && match[2].includes(dir) && Number(match[1]) !== process.pid) {
      try {
        process.kill(Number(match[1]), 'SIGKILL')
      } catch {}
    }
  }
}

function assert(condition, message) {
  if (!condition) {
    fail(message)
  }
}

function fail(message) {
  console.error(`FAIL ${message}`)
  process.exitCode = 1
  throw new Error(message)
}

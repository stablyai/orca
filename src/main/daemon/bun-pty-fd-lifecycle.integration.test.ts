import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { orcadBunRuntimeFilename } from '../../shared/orcad-artifacts'

const runtime =
  process.env.BUN_EXECUTABLE ?? resolve('out/orcad', orcadBunRuntimeFilename(process.platform))
const enabled = process.platform !== 'win32' && existsSync(runtime)

const script = `
import { readdirSync, readlinkSync } from 'node:fs'
import { spawnBunPty } from './src/main/daemon/pty-subprocess/bun-pty-process'
import { runProcessSync } from './src/shared/child-process/run-process'
const pause = () => new Promise(resolve => setTimeout(resolve, 50))
function terminalDescriptors() {
  if (process.platform === 'linux') {
    return readdirSync('/proc/self/fd').flatMap(fd => {
      try { return [readlinkSync('/proc/self/fd/' + fd)] } catch { return [] }
    }).filter(path => /\\/dev\\/(ptmx|pts\\/)/.test(path)).length
  }
  const result = runProcessSync({ program: 'lsof', args: ['-p', String(process.pid)], timeoutMs: 5000 })
  if (result.code !== 0) throw new Error('lsof failed: ' + result.stderr)
  return result.stdout.split('\\n').filter(line => /\\/dev\\/(ptmx|ttys[0-9])|\\(revoked\\)/.test(line)).length
}
function terminal(file = '/bin/sh', args = ['-c', 'exit 0']) {
  return spawnBunPty({ file, args, cwd: process.cwd(), env: process.env, cols: 80, rows: 24 })
}
async function exitedShell() {
  const proc = terminal()
  try { await new Promise(resolve => proc.onExit(resolve)) } finally { proc.destroy() }
}
await exitedShell()
await pause()
const before = terminalDescriptors()
for (let index = 0; index < 50; index++) await exitedShell()
await pause()
const afterExit = terminalDescriptors()
let failedSpawns = 0
for (let index = 0; index < 20; index++) {
  try { terminal('/orca-no-such-terminal-shell', []) } catch { failedSpawns++ }
}
await pause()
const afterFailure = terminalDescriptors()
let inherited = null
if (process.platform === 'linux') {
  const first = terminal('/bin/sh', ['-c', 'read value'])
  let second
  try {
    const laterChild = runProcessSync({ program: '/bin/sh', args: ['-c', 'ls -l /proc/self/fd'], timeoutMs: 5000 })
    if (laterChild.code !== 0) throw new Error('child descriptor listing failed')
    second = terminal('/bin/sh', ['-c', "read value; printf '__FD_LISTING_READY__\\n'; ls -l /proc/self/fd"])
    let output = ''
    second.onData(data => { output += data })
    const done = new Promise(resolve => second.onExit(resolve))
    second.write('go\\n')
    await done
    if (!output.includes('__FD_LISTING_READY__') || !/\\/dev\\/pts\\//.test(output)) throw new Error('missing terminal descriptor evidence')
    inherited = /ptmx/.test(laterChild.stdout) || /ptmx/.test(output)
  } finally {
    second?.destroy()
    const done = new Promise(resolve => first.onExit(resolve))
    first.write('done\\n')
    await done
    first.destroy()
  }
}
console.log(JSON.stringify({ exitLeak: afterExit - before, failedLeak: afterFailure - before, failedSpawns, inherited }))
`

describe.skipIf(!enabled)('Bun native PTY descriptor lifecycle', () => {
  it('releases exited and failed-spawn handles and prevents later-child inheritance', async () => {
    const result = await runProcess({
      program: runtime,
      args: ['--no-install', '--eval', script],
      cwd: process.cwd(),
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 20_000,
      terminationBarrier: true
    })
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      exitLeak: 0,
      failedLeak: 0,
      failedSpawns: 20,
      inherited: process.platform === 'linux' ? false : null
    })
  }, 25_000)
})

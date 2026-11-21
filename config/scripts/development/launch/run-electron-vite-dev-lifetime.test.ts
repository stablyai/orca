import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const children = new Set<ChildProcess>()
const processIds = new Set<number>()
const directories: string[] = []
const wrapperPath = resolve('config/scripts/development/launch/run-electron-vite-dev.mjs')
const intermediary = `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, process.argv.slice(1), { stdio: 'inherit' });
child.once('exit', (code) => process.exit(code ?? 1));
`

function collectOutput(child: ChildProcess): (pattern: RegExp) => Promise<RegExpMatchArray> {
  let output = ''
  const read = (chunk: Buffer): void => {
    output += chunk.toString()
  }
  child.stdout?.on('data', read)
  child.stderr?.on('data', read)
  return async (pattern) => {
    while (true) {
      const match = output.match(pattern)
      if (match) {
        return match
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Launcher exited before ${pattern}: ${output}`)
      }
      await Promise.race([
        once(child.stdout!, 'data'),
        once(child.stderr!, 'data'),
        once(child, 'exit')
      ])
    }
  }
}

async function launch(nested = false, extraEnv: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env }
  delete env.ORCA_DEV_OWNER_PID
  const directory = mkdtempSync(join(tmpdir(), 'orca-dev-lifetime-'))
  directories.push(directory)
  const cliPath = join(directory, 'cli.cjs')
  writeFileSync(
    cliPath,
    `
const { spawn } = require('node:child_process');
console.log('LIFETIME_OWNER', process.env.ORCA_DEV_OWNER_PID ?? 'unset');
const grandchild = spawn(process.execPath, ['-e', \`
  process.on('SIGTERM', () => console.log('LIFETIME_DRAINING', process.pid));
  process.on('SIGINT', () => {});
  process.on('SIGHUP', () => {});
  setInterval(() => {}, 1000);
  process.send('ready');
\`], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => process.exit(0));
}
grandchild.once('message', () => console.log('LIFETIME_READY', process.pid, grandchild.pid, process.ppid));
grandchild.once('message', () => {
  if (process.env.ORCA_DEV_LIFETIME_SELF_EXIT === '1') process.exit(0);
});
setInterval(() => {}, 1000);
`
  )
  const child = spawn(
    process.execPath,
    nested ? ['-e', intermediary, '-e', intermediary, wrapperPath] : [wrapperPath],
    {
      cwd: resolve('.'),
      env: {
        ...env,
        ORCA_BACKGROUND_LAUNCH: '1',
        ORCA_DEV_USER_DATA_PATH: join(directory, 'profile'),
        ORCA_ELECTRON_VITE_CLI: cliPath,
        ORCA_SKIP_DEV_CLI_PREPARE: '1',
        ORCA_SKIP_DEV_ELECTRON_APP_PREPARE: '1',
        ORCA_SKIP_DEV_WEB_PREPARE: '1',
        ORCA_SKIP_DEV_STORAGE_RECLAIM: '1',
        ...extraEnv
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  children.add(child)
  const read = collectOutput(child)
  const match = await read(/LIFETIME_READY (\d+) (\d+) (\d+)/)
  const cliPid = Number(match[1])
  const grandchildPid = Number(match[2])
  processIds.add(Number(match[3]))
  processIds.add(cliPid)
  processIds.add(grandchildPid)
  const instance = await read(/ORCA_DEV_INSTANCE (.+)/)
  const runnerPid = JSON.parse(instance[1]).runnerPid
  processIds.add(runnerPid)
  return { child, cliPid, grandchildPid, runnerPid, read }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
      throw error
    }
  }
}

function stopped(pid: number): boolean {
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8'
    }).trim()
    return state === '' || state.startsWith('Z')
  } catch (error) {
    return error instanceof Error && 'status' in error && error.status === 1
  }
}

describe.skipIf(process.platform === 'win32')('dev launch lifetime', () => {
  afterEach(() => {
    for (const child of children) {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        signalGroup(child.pid, 'SIGKILL')
      }
    }
    for (const pid of processIds) {
      if (!stopped(pid)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
            throw error
          }
        }
      }
    }
    children.clear()
    processIds.clear()
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129]
  ] as const)(
    'cleans resistant descendants after %s even when Vite exits first',
    async (signal, code) => {
      const { child, cliPid, grandchildPid } = await launch()
      const exited = once(child, 'exit')
      child.kill(signal)
      expect(await exited).toEqual([code, null])
      await expect.poll(() => stopped(cliPid) && stopped(grandchildPid)).toBe(true)
    },
    15_000
  )

  // Includes a real owner probe and the five-second forced-shutdown grace.
  it('stops a background runner when its owner exits above a surviving script shell', async () => {
    const { child, runnerPid, grandchildPid } = await launch(true)
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
    await expect
      .poll(() => stopped(runnerPid) && stopped(grandchildPid), { timeout: 12_000 })
      .toBe(true)
  }, 15_000)

  // Includes the real supervisor disconnect and five-second forced-shutdown grace.
  it('cleans detached descendants when the entire launching command group is killed', async () => {
    const { child, cliPid, grandchildPid } = await launch(true)
    const exited = once(child, 'exit')
    if (!child.pid) {
      throw new Error('Missing command group PID')
    }
    signalGroup(child.pid, 'SIGKILL')
    await exited
    await expect
      .poll(() => stopped(cliPid) && stopped(grandchildPid), { timeout: 12_000 })
      .toBe(true)
  }, 15_000)
  // The resistant descendant must run through the five-second shutdown grace.
  it('drains descendants when Vite exits without a shutdown signal', async () => {
    const { child, grandchildPid } = await launch(false, { ORCA_DEV_LIFETIME_SELF_EXIT: '1' })
    expect(await once(child, 'exit')).toEqual([0, null])
    await expect.poll(() => stopped(grandchildPid)).toBe(true)
  }, 15_000)

  // Includes the real supervisor disconnect and five-second forced-shutdown grace.
  it('retains supervision if the command group dies after Vite exits during cleanup', async () => {
    const { child, grandchildPid, read } = await launch(true, { ORCA_DEV_LIFETIME_SELF_EXIT: '1' })
    await read(/LIFETIME_DRAINING/)
    if (!child.pid) {
      throw new Error('Missing command group PID')
    }
    const exited = once(child, 'exit')
    signalGroup(child.pid, 'SIGKILL')
    await exited
    await expect.poll(() => stopped(grandchildPid), { timeout: 12_000 }).toBe(true)
  }, 15_000)

  // Includes a real owner probe and the five-second forced-shutdown grace.
  it('honors an explicit owner while the immediate launch parent remains alive', async () => {
    const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore'
    })
    children.add(owner)
    if (!owner.pid) {
      throw new Error('Missing explicit owner PID')
    }
    const { child, grandchildPid, read } = await launch(false, {
      ORCA_DEV_OWNER_PID: String(owner.pid)
    })
    await read(/LIFETIME_OWNER unset/)
    const exited = once(child, 'exit')
    owner.kill('SIGKILL')
    expect(await exited).toEqual([143, null])
    await expect.poll(() => stopped(grandchildPid)).toBe(true)
  }, 15_000)
})

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ORCAD_WSL_HOLDER_RELEASE_FILENAME } from '../../shared/orcad-idle-exit'
import { buildWslDistroHolderScript, WSL_DISTRO_HOLDER_MARKER } from './wsl-distro-holder-command'

// The script runs inside the distro; any POSIX sh here exercises the same text.
let home: string
let children: ChildProcess[]

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-holder-script-'))
  mkdirSync(join(home, '.orca'))
  children = []
})

afterEach(() => {
  for (const child of children) {
    child.kill('SIGKILL')
  }
  rmSync(home, { recursive: true, force: true })
})

function track(child: ChildProcess): ChildProcess {
  children.push(child)
  return child
}

function startHolder(env: NodeJS.ProcessEnv = { HOME: home, PATH: process.env.PATH }) {
  const child = track(
    spawn('/bin/sh', ['-c', buildWslDistroHolderScript(1), WSL_DISTRO_HOLDER_MARKER], {
      env,
      stdio: 'ignore'
    })
  )
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
  return { child, exited }
}

function within(ms: number, promise: Promise<number | null>): Promise<number | null | 'running'> {
  return Promise.race([
    promise,
    new Promise<'running'>((resolve) => setTimeout(() => resolve('running'), ms))
  ])
}

const releasePath = (): string => join(home, '.orca', ORCAD_WSL_HOLDER_RELEASE_FILENAME)

describe.skipIf(process.platform === 'win32')('WSL distro holder script', () => {
  it('holds while nothing asked for a release', async () => {
    const { exited } = startHolder()
    expect(await within(2_500, exited)).toBe('running')
  })

  it('waits for the requesting orcad to exit, then claims the request and ends', async () => {
    const orcad = track(spawn('/bin/sh', ['-c', 'sleep 30'], { stdio: 'ignore' }))
    writeFileSync(releasePath(), `${orcad.pid}\n`)
    const { exited } = startHolder()

    expect(await within(2_500, exited)).toBe('running')
    orcad.kill('SIGKILL')
    expect(await within(4_000, exited)).toBe(0)
    expect(existsSync(releasePath())).toBe(false)
  })

  it('keeps holding when a starting orcad withdrew the request first', async () => {
    const orcad = track(spawn('/bin/sh', ['-c', 'sleep 30'], { stdio: 'ignore' }))
    writeFileSync(releasePath(), `${orcad.pid}\n`)
    const { exited } = startHolder()
    await within(1_500, exited)
    rmSync(releasePath())
    orcad.kill('SIGKILL')
    expect(await within(3_000, exited)).toBe('running')
  })

  it('ignores a request it cannot read as a pid', async () => {
    writeFileSync(releasePath(), 'not-a-pid\n')
    const { exited } = startHolder()
    expect(await within(2_500, exited)).toBe('running')
  })

  it('never releases without a home to find the request in', async () => {
    writeFileSync(releasePath(), '999999\n')
    const { exited } = startHolder({ PATH: process.env.PATH })
    expect(await within(2_500, exited)).toBe('running')
  })
})

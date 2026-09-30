import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { once } from 'node:events'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  runProcess,
  spawnProcess,
  type ChildProcessHandle
} from '../../shared/child-process/run-process'
import {
  buildWslGuestTreeKillArgs,
  buildWslGuestTreeKillInput
} from './wsl-guest-tree-kill-command'

let directory: string
let binary: string
const children = new Set<ChildProcessHandle>()
const markerName = 'ORCA_PTY_TREE_ID'

async function startChild(
  marker: string,
  extraEnv: Record<string, string> = {}
): Promise<ChildProcessHandle> {
  const child = spawnProcess({
    program: process.execPath,
    args: [
      '-e',
      `
      if (process.env.TEST_DROP_UID === '1') process.setuid(65534)
      process.on('SIGTERM', () => {})
      process.stdout.write('ready\\n')
      setInterval(() => {}, 1000)
    `
    ],
    env: { ...process.env, [markerName]: marker, ...extraEnv }
  })
  children.add(child)
  const ready = child.stdout
    ? once(child.stdout, 'data')
    : Promise.reject(new Error('missing stdout'))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      ready,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('test child failed to become ready')), 3_000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
  return child
}

async function stopChild(child: ChildProcessHandle): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const exit = once(child, 'exit')
    child.kill('SIGKILL')
    await exit
  }
  children.delete(child)
}

async function expectExited(child: ChildProcessHandle): Promise<void> {
  const deadline = performance.now() + 2_000
  while (child.exitCode === null && child.signalCode === null && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(child.signalCode).toBe('SIGKILL')
}

describe.skipIf(process.platform !== 'linux')('native WSL guest cleanup', () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-native-guest-test-'))
    binary = process.env.ORCA_GUEST_TREE_KILL_TEST_BINARY ?? join(directory, 'helper')
    const compile = async (source: string, output: string): Promise<void> => {
      const result = await runProcess({
        program: 'gcc',
        args: ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', source, '-o', output],
        timeoutMs: 30_000
      })
      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
    }
    if (!process.env.ORCA_GUEST_TREE_KILL_TEST_BINARY) {
      await compile('native/linux-guest-tree-kill/main.c', binary)
    }
    await compile('native/linux-guest-tree-kill/main.test.c', join(directory, 'unit'))
  })

  afterAll(async () => {
    await Promise.all([...children].map(stopChild))
    if (directory) {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('runs native ownership, replaced-PID-directory and failure regressions', async () => {
    const result = await runProcess({ program: join(directory, 'unit'), timeoutMs: 5_000 })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('native ownership and failure checks passed')
  })

  it('kills a real marked TERM-ignoring child and spares unmarked/prefix-marker children', async () => {
    const marker = randomUUID()
    const owned = await startChild(marker)
    const prefix = await startChild(`${marker}-other`)
    const unrelated = await startChild(randomUUID())
    try {
      const started = performance.now()
      const result = await runProcess({ program: binary, args: [marker, '600'], timeoutMs: 2_000 })
      expect(result.timedOut).toBe(false)
      // Unreadable unrelated /proc entries remain unverifiable under unprivileged test users.
      expect([0, 2]).toContain(result.code)
      await expectExited(owned)
      expect(prefix.exitCode).toBeNull()
      expect(prefix.signalCode).toBeNull()
      expect(unrelated.exitCode).toBeNull()
      expect(unrelated.signalCode).toBeNull()
      expect(performance.now() - started).toBeLessThan(2_000)
    } finally {
      await Promise.all([owned, prefix, unrelated].map(stopChild))
    }
  })

  it('executes the host-generated default-budget bootstrap and cleans its private copy', async () => {
    const marker = randomUUID()
    const owned = await startChild(marker)
    const sha256 = createHash('sha256')
      .update(await readFile(binary))
      .digest('hex')
    const artifact = { path: binary, sha256, bytes: await readFile(binary) }
    const argv = buildWslGuestTreeKillArgs(
      'Ubuntu',
      marker,
      { x64: artifact, arm64: artifact },
      3250
    )
    expect(argv.at(-1)).toBe('3000')
    const envArgs = argv.slice(6)
    const temporaryPathFile = join(directory, 'private-copy-path')
    const scriptIndex = envArgs.indexOf('-c') + 1
    envArgs[scriptIndex] =
      `mktemp() { command mktemp "$@" | tee '${temporaryPathFile}'; }\n${envArgs[scriptIndex]}`
    try {
      const result = await runProcess({
        program: '/usr/bin/env',
        args: envArgs,
        input: buildWslGuestTreeKillInput({ x64: artifact, arm64: artifact }),
        timeoutMs: 4_000
      })
      expect(result.timedOut).toBe(false)
      expect([0, 2]).toContain(result.code)
      await expectExited(owned)
      const temporaryPath = (await readFile(temporaryPathFile, 'utf8')).trim()
      await expect(stat(temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await stopChild(owned)
    }
  })

  it('refuses a corrupt private copy before running it', async () => {
    const touched = join(directory, 'must-not-run')
    const executable = join(directory, 'tampered')
    await writeFile(executable, `#!/bin/sh\ntouch '${touched}'\n`)
    const artifact = { path: executable, sha256: '0'.repeat(64), bytes: await readFile(executable) }
    const argv = buildWslGuestTreeKillArgs(
      'Ubuntu',
      randomUUID(),
      { x64: artifact, arm64: artifact },
      600
    )
    const envArgs = argv.slice(6)
    const result = await runProcess({
      program: '/usr/bin/env',
      args: envArgs,
      input: buildWslGuestTreeKillInput({ x64: artifact, arm64: artifact }),
      timeoutMs: 2_000
    })
    expect(result.code).toBe(3)
    await expect(readFile(touched)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    ['invalid', '600'],
    [randomUUID(), '3001'],
    [randomUUID(), 'NaN']
  ])('rejects malformed marker/budget without signaling: %s %s', async (marker, budget) => {
    const result = await runProcess({ program: binary, args: [marker, budget], timeoutMs: 2_000 })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('unverifiable')
  })

  it.skipIf(process.getuid?.() !== 0)(
    'reaches a marker-retaining cross-UID child when already root',
    async () => {
      const marker = randomUUID()
      const child = await startChild(marker, { TEST_DROP_UID: '1' })
      try {
        const result = await runProcess({
          program: binary,
          args: [marker, '600'],
          timeoutMs: 2_000
        })
        expect([0, 2]).toContain(result.code)
        await expectExited(child)
      } finally {
        await stopChild(child)
      }
    }
  )
})

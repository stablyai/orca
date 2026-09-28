import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { resolveBunRuntime } from './pty-subprocess/bun-pty-process-capabilities'
import type { BunTerminalOptions } from './pty-subprocess/bun-pty-process-contract'
import { spawnBunPty } from './pty-subprocess/bun-pty-process'
import { createWindowsBunPtyLaunch } from './pty-subprocess/windows-bun-pty-launch'

const CHILD = `
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('NATIVE_READY');
process.stdin.on('data', chunk => {
  if (chunk.toString().includes('finish')) {
    process.stdout.write('FINAL_STATE_END', () => process.exit(17));
  } else {
    process.stdout.write('WITNESS_REPLY_END');
  }
});`

export async function runWindowsNativeIoFailure(options: {
  operation: 'write-close' | 'late-write' | 'drain-close'
  workerPath?: string
}) {
  if (process.platform !== 'win32') {
    throw new Error('Windows native qualification only')
  }
  const runtime = resolveBunRuntime()
  let closeOnWrite = false
  let nativeFailure = ''
  class ClosingTerminal extends runtime.Terminal {
    constructor(args: BunTerminalOptions) {
      super(args)
      const nativeWrite = this.write.bind(this)
      this.write = (data) => {
        if (closeOnWrite) {
          closeOnWrite = false
          this.close()
        }
        try {
          return nativeWrite(data)
        } catch (error) {
          nativeFailure = error instanceof Error ? error.message : String(error)
          throw error
        }
      }
    }
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
  const launch = (victim: boolean) => {
    const proc = spawnBunPty(
      {
        file: process.execPath,
        args: ['--no-env-file', '-e', CHILD],
        cwd: process.cwd(),
        env,
        cols: 120,
        rows: 30,
        windowsJobKillOnClose: true
      },
      {
        ...(victim
          ? { runtime: { Terminal: ClosingTerminal, spawn: runtime.spawn.bind(runtime) } }
          : {}),
        createWindowsLaunch: (args) =>
          createWindowsBunPtyLaunch(args, {
            workerPath:
              options.workerPath ?? join(__dirname, 'pty-subprocess/windows-bun-pty-gate-entry.ts')
          })
      }
    )
    let output = ''
    let exitCount = 0
    let finalOutputBeforeExit = false
    proc.onData((data) => {
      output += data
    })
    const exited = new Promise<number>((resolve) => {
      proc.onExit(({ exitCode }) => {
        finalOutputBeforeExit = output.includes('FINAL_STATE_END')
        exitCount++
        resolve(exitCode)
      })
    })
    return {
      proc,
      exited,
      output: () => output,
      exitCount: () => exitCount,
      finalOutputBeforeExit: () => finalOutputBeforeExit
    }
  }
  const uncaught: string[] = []
  const onUncaught = (error: Error) => {
    uncaught.push(error.message)
  }
  process.on('uncaughtException', onUncaught)
  const terminals: ReturnType<typeof launch>[] = []
  const bounded = async <T>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Native I/O fixture deadline exceeded')),
            15_000
          )
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }
  const waitFor = async (terminal: ReturnType<typeof launch>, marker: string) => {
    const deadline = Date.now() + 15_000
    while (!terminal.output().includes(marker)) {
      if (Date.now() > deadline) {
        throw new Error(`Missing ${marker}: ${terminal.output()}`)
      }
      await delay(10)
    }
  }
  try {
    const victim = launch(true)
    terminals.push(victim)
    const witness = launch(false)
    terminals.push(witness)
    await bounded(Promise.all(terminals.map(async (t) => t.proc.waitForSpawn?.())))
    await Promise.all(terminals.map((t) => waitFor(t, 'NATIVE_READY')))
    if (options.operation === 'write-close') {
      // Close the real native handle after the adapter's check; no synthetic exception.
      closeOnWrite = true
      victim.proc.write('trigger')
    } else if (options.operation === 'late-write') {
      victim.proc.kill()
    } else {
      victim.proc.write('finish')
    }
    const exitCode = await bounded(victim.exited)
    victim.proc.write('late input')
    victim.proc.resize(90, 24)
    await delay(1_500)
    witness.proc.write('probe')
    await waitFor(witness, 'WITNESS_REPLY_END')
    return {
      nativeFailure,
      exitCode,
      victimExitCount: victim.exitCount(),
      witnessExitCount: witness.exitCount(),
      witnessWritable: true,
      finalOutputBeforeExit: victim.finalOutputBeforeExit(),
      uncaught
    }
  } finally {
    try {
      await bounded(
        Promise.all(
          terminals.map(async ({ proc, exited }) => {
            try {
              proc.kill()
              await exited
            } finally {
              proc.destroy()
            }
          })
        )
      )
    } finally {
      await delay(1_500)
      process.off('uncaughtException', onUncaught)
    }
  }
}

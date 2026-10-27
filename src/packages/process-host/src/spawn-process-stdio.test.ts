import { once } from 'node:events'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import type { ChildProcessHandle, PipedChildProcess, ProcessSpec } from './process-spec'

async function waitForClose(child: ChildProcessHandle): Promise<void> {
  try {
    await once(child, 'close', { signal: AbortSignal.timeout(5_000) })
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closing = once(child, 'close', { signal: AbortSignal.timeout(1_000) })
      child.kill('SIGKILL')
      await closing
    }
  }
}

describe('public spawn stream contracts', () => {
  it('returns three pipes by default', async () => {
    const child = spawnProcess({ program: process.execPath, args: ['-e', ''] })
    expectTypeOf(child).toEqualTypeOf<PipedChildProcess>()
    await waitForClose(child)
    expect(child.stdin).not.toBeNull()
    expect(child.stdout).not.toBeNull()
    expect(child.stderr).not.toBeNull()
  })

  it('returns three pipes for an explicit pipe mode', async () => {
    const child = spawnProcess({ program: process.execPath, args: ['-e', ''], stdio: 'pipe' })
    expectTypeOf(child).toEqualTypeOf<PipedChildProcess>()
    await waitForClose(child)
    expect(child.stdin).not.toBeNull()
    expect(child.stdout).not.toBeNull()
    expect(child.stderr).not.toBeNull()
  })

  it('returns three pipes for an explicit pipe tuple', async () => {
    const child = spawnProcess({
      program: process.execPath,
      args: ['-e', ''],
      stdio: ['pipe', 'pipe', 'pipe']
    })
    expectTypeOf(child).toEqualTypeOf<PipedChildProcess>()
    await waitForClose(child)
    expect(child.stdin).not.toBeNull()
    expect(child.stdout).not.toBeNull()
    expect(child.stderr).not.toBeNull()
  })

  it('keeps three pipes when the tuple adds an IPC channel', async () => {
    const child = spawnProcess({
      program: process.execPath,
      args: ['-e', 'process.disconnect()'],
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    })
    expectTypeOf(child).toEqualTypeOf<PipedChildProcess>()
    await waitForClose(child)
    expect(child.stdin).not.toBeNull()
    expect(child.stdout).not.toBeNull()
    expect(child.stderr).not.toBeNull()
  })

  it.each(['ignore', 'inherit'] as const)('returns nullable streams for %s', async (stdio) => {
    const child = spawnProcess({ program: process.execPath, args: ['-e', ''], stdio })
    expectTypeOf(child).toEqualTypeOf<ChildProcessHandle>()
    await waitForClose(child)
    expect(child.stdin).toBeNull()
    expect(child.stdout).toBeNull()
    expect(child.stderr).toBeNull()
  })

  it('does not promise a stdin pipe when only the output slots are piped', async () => {
    const child = spawnProcess({
      program: process.execPath,
      args: ['-e', ''],
      stdio: ['ignore', 'pipe', 'pipe']
    })
    expectTypeOf(child).toEqualTypeOf<ChildProcessHandle>()
    await waitForClose(child)
    expect(child.stdin).toBeNull()
    expect(child.stdout).not.toBeNull()
    expect(child.stderr).not.toBeNull()
  })

  it('keeps the general contract when the specification does not guarantee pipes', async () => {
    const spec: ProcessSpec = { program: process.execPath, args: ['-e', ''] }
    const child = spawnProcess(spec)
    expectTypeOf(child).toEqualTypeOf<ChildProcessHandle>()
    await waitForClose(child)
  })
})

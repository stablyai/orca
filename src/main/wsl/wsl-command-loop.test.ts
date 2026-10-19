import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import type { PipedChildProcess } from '@orca/process-host/process-spec'
import { execCommand } from '../ssh/remote-exec/remote-exec-command'
import { WSL_COMMAND_LOOP_ARGV0, WSL_COMMAND_LOOP_SCRIPT } from './wsl-command-loop'
import { createWslCommandLoopPool, type WslCommandLoopPool } from './wsl-command-loop-pool'

// The guest side is plain POSIX sh, so a local sh stands in for `wsl.exe --exec sh`.
const posix = process.platform !== 'win32'
const spawned: PipedChildProcess[] = []
const pools: WslCommandLoopPool[] = []

function pool(options: { maxLoops?: number; script?: string } = {}) {
  const created = createWslCommandLoopPool({
    maxLoops: options.maxLoops,
    spawnLoop: (marker) => {
      const child = spawnProcess({
        program: 'sh',
        args: ['-c', options.script ?? WSL_COMMAND_LOOP_SCRIPT, WSL_COMMAND_LOOP_ARGV0, marker]
      })
      spawned.push(child)
      return child
    }
  })
  pools.push(created)
  const conn = {
    exec: () => Promise.reject(new Error('direct exec')),
    execWithClosedStdin: async (command: string, options?: { signal?: AbortSignal }) => {
      const channel = await created.run(command, options?.signal)
      if (!channel) {
        throw new Error('loop unavailable')
      }
      return channel
    },
    usesSystemSshTransport: () => false
  }
  return { pool: created, conn }
}

afterEach(() => {
  pools.splice(0).forEach((entry) => entry.dispose())
  spawned.splice(0).forEach((child) => child.kill())
})

describe.runIf(posix)('WSL command loop', () => {
  it('runs many commands over one process with their own stdout, stderr and status', async () => {
    const { conn } = pool()
    expect(await execCommand(conn, 'echo one')).toBe('one\n')
    expect(await execCommand(conn, "printf 'a\\nb'")).toBe('a\nb')
    let stderr = ''
    expect(
      await execCommand(conn, 'echo out; echo err >&2', {
        onStderr: (text) => (stderr = text)
      })
    ).toBe('out\n')
    expect(stderr).toBe('err\n')
    await expect(execCommand(conn, 'echo partial; exit 7')).rejects.toMatchObject({
      exitCode: 7,
      stdout: 'partial\n'
    })
    expect(spawned).toHaveLength(1)
  })

  it('keeps binary output, quoting and multi-line scripts intact', async () => {
    const { conn } = pool()
    const script = "x='it''s'\nfor i in 1 2; do printf '%s-%s\\n' \"$x\" $i; done"
    expect(await execCommand(conn, script)).toBe('its-1\nits-2\n')
    expect(await execCommand(conn, 'printf "\\0\\377"')).toBe(
      Buffer.from([0, 0xff]).toString('utf-8')
    )
  })

  it('gives each command EOF on stdin, its own session and no loop variables', async () => {
    const { conn } = pool()
    expect(await execCommand(conn, 'cat; echo eof')).toBe('eof\n')
    expect(await execCommand(conn, 'echo "[${m:-}${d:-}${l:-}]"')).toBe('[]\n')
    const sessionLeads = await execCommand(
      conn,
      'if command -v setsid >/dev/null 2>&1; then [ "$(ps -o sid= -p $$ | tr -d " ")" = "$$" ] && echo own || echo shared; else echo own; fi'
    )
    expect(sessionLeads).toBe('own\n')
  })

  it('runs concurrent commands on separate loops up to the cap, then declines', async () => {
    const { pool: loops, conn } = pool({ maxLoops: 2 })
    const slow = [execCommand(conn, 'sleep 0.3; echo a'), execCommand(conn, 'sleep 0.3; echo b')]
    await new Promise((resolve) => setTimeout(resolve, 50))
    await expect(loops.run('echo c')).resolves.toBeNull()
    expect(await Promise.all(slow)).toEqual(['a\n', 'b\n'])
    expect(await execCommand(conn, 'echo d')).toBe('d\n')
    expect(spawned).toHaveLength(2)
  })

  it('does not let a backgrounded writer leak into the next command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-wsl-loop-'))
    try {
      const { conn } = pool()
      await execCommand(conn, `(sleep 0.2; echo late; echo done > '${dir}/f') &`)
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(readFileSync(join(dir, 'f'), 'utf8')).toBe('done\n')
      expect(await execCommand(conn, 'echo next')).toBe('next\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('kills the loop when a command is aborted, and later commands start a new one', async () => {
    const { conn } = pool()
    const controller = new AbortController()
    const running = execCommand(conn, 'sleep 30', {
      signal: controller.signal
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    controller.abort()
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
    expect(await execCommand(conn, 'echo again')).toBe('again\n')
    expect(spawned).toHaveLength(2)
  })

  it('declines for good when the guest loop cannot start', async () => {
    const { pool: loops } = pool({ script: 'exit 98' })
    await expect(loops.run('echo x')).resolves.toBeNull()
    await expect(loops.run('echo y')).resolves.toBeNull()
    expect(spawned).toHaveLength(1)
  })

  it('reports a loop that dies mid-command as a failed command', async () => {
    const { conn } = pool()
    await expect(execCommand(conn, 'kill -9 $PPID 2>/dev/null; sleep 5')).rejects.toThrow()
    expect(await execCommand(conn, 'echo recovered')).toBe('recovered\n')
  })
})

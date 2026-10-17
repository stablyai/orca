import type * as ProcessHost from '@orca/process-host'
import type { ProcessSpec } from '@orca/process-host/process-spec'
import { describe, expect, it, vi } from 'vitest'
import { spawnProxyCommand } from './ssh-proxy-command'

const { fixture } = vi.hoisted(() => ({ fixture: { script: '' } }))

vi.mock('@orca/process-host', async (importOriginal) => {
  const original = await importOriginal<typeof ProcessHost>()
  return {
    ...original,
    spawnProcess: (spec: ProcessSpec) =>
      original.spawnProcess({ ...spec, program: process.execPath, args: ['-e', fixture.script] })
  }
})

type Proxy = ReturnType<typeof spawnProxyCommand>
type ChildClose = { code: number | null; signal: NodeJS.Signals | null }

async function within<T>(operation: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function withProxy(
  script: string,
  check: (proxy: Proxy, closed: Promise<ChildClose>, output: Buffer[]) => Promise<void>
): Promise<void> {
  fixture.script = script
  const proxy = spawnProxyCommand(
    { kind: 'jump-host', jumpHost: 'owned-node-fixture' },
    'target.example.com',
    22,
    'deploy'
  )
  let childClosed = false
  const closed = new Promise<ChildClose>((resolve) => {
    proxy.process.once('close', (code, signal) => {
      childClosed = true
      resolve({ code, signal })
    })
  })
  const output: Buffer[] = []
  proxy.sock.on('data', (chunk: Buffer) => output.push(chunk))
  proxy.sock.on('error', () => {})
  try {
    const ready = new Promise<void>((resolve, reject) => {
      proxy.sock.once('data', () => resolve())
      proxy.sock.once('error', reject)
    })
    await within(ready, 'fixture readiness', 5_000)
    expect(Buffer.concat(output).toString()).toBe('READY\n')
    await check(proxy, closed, output)
  } finally {
    proxy.sock.destroy()
    if (!childClosed) {
      // The negative control must not leave its deliberately idle child behind.
      for (const emitter of [
        proxy.process,
        proxy.process.stdin,
        proxy.process.stdout,
        proxy.process.stderr
      ]) {
        emitter?.on('error', () => {})
      }
      proxy.process.stdin?.destroy()
      proxy.process.stdout?.destroy()
      proxy.process.stderr?.destroy()
      proxy.process.kill('SIGKILL')
      await within(closed, 'fixture cleanup', 5_000)
    }
  }
}

describe('ProxyJump process lifetime', () => {
  it('observes actual child close after destroying its transport', async () => {
    await withProxy(
      "setInterval(() => {}, 60_000); process.stdin.resume(); process.stdout.write('READY\\n')",
      async ({ process: child, sock }, closed) => {
        const kill = vi.spyOn(child, 'kill')
        expect(child.exitCode).toBeNull()

        sock.destroy()
        await within(closed, 'child close after socket destruction')

        expect(kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
        expect(child.stdin?.destroyed).toBe(true)
        expect(child.stdout?.destroyed).toBe(true)
        expect(child.stderr?.destroyed).toBe(true)
      }
    )
  })

  it('settles blocked and queued writes when the transport is destroyed', async () => {
    await withProxy(
      "setInterval(() => {}, 60_000); process.stdout.write('READY\\n')",
      async ({ sock }, closed) => {
        const written = new Promise<Error | null | undefined>((resolve) => {
          sock.write(Buffer.alloc(8 * 1024 * 1024), resolve)
        })
        const queued = new Promise<Error | null | undefined>((resolve) => {
          sock.write(Buffer.from('queued'), resolve)
        })

        sock.destroy()
        const errors = await within(Promise.all([written, queued]), 'blocked and queued callbacks')
        expect(errors).toHaveLength(2)
        for (const error of errors) {
          expect(error).toBeInstanceOf(Error)
        }
        await within(closed, 'blocked writer child close')
      }
    )
  })

  it('accepts EOF after the owned stdin pipe has already closed', async () => {
    await withProxy(
      "setInterval(() => {}, 60_000); process.stdin.resume(); process.stdout.write('READY\\n')",
      async ({ process: child, sock }, closed) => {
        child.stdin?.destroy()
        expect(child.stdin?.destroyed).toBe(true)

        await within(
          new Promise<void>((resolve, reject) => {
            sock.end((error?: Error | null) => (error ? reject(error) : resolve()))
          }),
          'EOF after stdin close'
        )
        expect(sock.writableFinished).toBe(true)

        sock.destroy()
        await within(closed, 'closed stdin child cleanup')
      }
    )
  })

  it('preserves live echo and forwards EOF so the child exits normally', async () => {
    await withProxy(
      "process.stdin.on('data', data => process.stdout.write(data)); process.stdin.on('end', () => process.stdout.end()); process.stdout.write('READY\\n')",
      async ({ process: child, sock }, closed, output) => {
        const kill = vi.spyOn(child, 'kill')
        const payload = Buffer.from('proxy echo\n')
        await within(
          new Promise<void>((resolve, reject) => {
            sock.end(payload, (error?: Error | null) => (error ? reject(error) : resolve()))
          }),
          'proxy EOF'
        )

        expect(await within(closed, 'normal EOF child close')).toEqual({ code: 0, signal: null })
        expect(Buffer.concat(output)).toEqual(Buffer.concat([Buffer.from('READY\n'), payload]))
        expect(kill).not.toHaveBeenCalled()
      }
    )
  })
})

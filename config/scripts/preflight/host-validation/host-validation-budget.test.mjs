import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'

const fixture = fileURLToPath(new URL('./fixtures/validation-task.mjs', import.meta.url))
const children = []
const directories = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await once(child, 'close')
    }
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

async function setup() {
  const reservation = createServer()
  reservation.listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = reservation.address().port
  await new Promise((resolve) => reservation.close(resolve))
  const root = mkdtempSync(join(tmpdir(), 'orca-validation-'))
  directories.push(root)
  const start = (name, env = {}, args = []) => {
    const cwd = join(root, name)
    mkdirSync(cwd)
    const child = spawn(
      process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath,
      [fixture, ...args],
      {
        cwd,
        env: {
          ...process.env,
          CI: '',
          GITHUB_ACTIONS: '',
          ORCA_VALIDATION_TOKEN: '',
          ORCA_VALIDATION_PORT: String(port),
          ...env
        },
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    children.push(child)
    let output = ''
    const waiters = []
    const append = (chunk) => {
      output += chunk
      for (const waiter of waiters) {
        if (output.includes(waiter.text)) {
          waiter.resolve(output)
        }
      }
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    return {
      child,
      output: () => output,
      wait: (text) =>
        output.includes(text)
          ? Promise.resolve(output)
          : new Promise((resolve) => waiters.push({ text, resolve })),
      closed: new Promise((resolve) =>
        child.once('close', (code, signal) => resolve({ code, signal }))
      )
    }
  }
  return start
}

const running = (output) => JSON.parse(output.split('\n').find((line) => line.startsWith('{')))
const gone = (pid) => {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if (error.code === 'ESRCH') {
      return true
    }
    throw error
  }
}

it.skipIf(process.platform === 'win32')(
  'queues independent workspaces, admits nested validation, and preserves failures',
  async () => {
    const start = await setup()
    const first = start('public')
    const owner = running(await first.wait('"running"'))
    const second = start('private')
    await second.wait('waiting for host lane')
    first.child.stdin.write('nested\n')
    await first.wait('nested-finished')
    first.child.stdin.write('7\n')
    expect(await first.closed).toEqual({ code: 7, signal: null })
    await second.wait('"running"')
    await expect.poll(() => gone(owner.child)).toBe(true)
    second.child.stdin.write('0\n')
    expect(await second.closed).toEqual({ code: 0, signal: null })
  },
  20_000
)

it.skipIf(process.platform === 'win32')(
  'cancels a queued command without starting it or stranding the lane',
  async () => {
    const start = await setup()
    const first = start('owner')
    await first.wait('"running"')
    const canceled = start('canceled')
    await canceled.wait('waiting for host lane')
    canceled.child.kill('SIGTERM')
    expect(await canceled.closed).toEqual({ code: 143, signal: null })
    expect(canceled.output()).not.toContain('"running"')
    first.child.stdin.write('0\n')
    expect(await first.closed).toEqual({ code: 0, signal: null })
    const next = start('next')
    await next.wait('"running"')
    next.child.stdin.write('0\n')
    expect(await next.closed).toEqual({ code: 0, signal: null })
  },
  20_000
)

it.skipIf(process.platform === 'win32')(
  'rejects an inherited lease after its owner is gone',
  async () => {
    const start = await setup()
    const stale = start('stale', { ORCA_VALIDATION_TOKEN: 'retired-owner' })
    expect(await stale.closed).toEqual({ code: 1, signal: null })
    expect(stale.output()).toContain('Inherited host validation lane is no longer live')
    expect(stale.output()).not.toContain('"running"')
  }
)

it.skipIf(process.platform === 'win32')(
  'retires signal-resistant workers before releasing canceled admission',
  async () => {
    const start = await setup()
    const first = start('owner', {}, ['--ignore-cancel'])
    const owner = running(await first.wait('"running"'))
    const next = start('next')
    await next.wait('waiting for host lane')
    first.child.kill('SIGTERM')
    expect(await first.closed).toEqual({ code: 143, signal: null })
    await next.wait('"running"')
    await expect.poll(() => gone(owner.child) && gone(owner.pid) && gone(owner.group)).toBe(true)
    next.child.stdin.write('0\n')
    expect(await next.closed).toEqual({ code: 0, signal: null })
  },
  20_000
)

it.skipIf(process.platform === 'win32').each(['parent', 'group', 'entry', 'cancel'])(
  'recovers from %s loss only after retiring its process tree',
  async (target) => {
    const start = await setup()
    const first = start('owner')
    const owner = running(await first.wait('"running"'))
    const next = start('next')
    await next.wait('waiting for host lane')
    if (target === 'parent') {
      first.child.kill('SIGKILL')
    } else if (target === 'cancel') {
      first.child.kill('SIGTERM')
    } else {
      process.kill(target === 'group' ? owner.group : owner.pid, 'SIGKILL')
    }
    await first.closed
    await next.wait('"running"')
    await expect.poll(() => gone(owner.child) && gone(owner.pid) && gone(owner.group)).toBe(true)
    next.child.stdin.write('0\n')
    expect(await next.closed).toEqual({ code: 0, signal: null })
  },
  20_000
)

import { once } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProcess, runProcessSync, spawnProcess } from '@orca/process-host'
import { afterEach, expect, it } from 'vitest'
import { withLocalCheckSlot } from './local-check-slot.mjs'

const workers = []
const directories = []
const slotModule = new URL('./local-check-slot.mjs', import.meta.url).href
const changedCheckScript = fileURLToPath(
  new URL('../changed-checks/check-changed.mjs', import.meta.url)
)
const source = `
  import { once } from 'node:events';
  import { withLocalCheckSlot } from ${JSON.stringify(slotModule)};
  await withLocalCheckSlot(async () => {
    await withLocalCheckSlot(async () => {});
    process.send('running');
    await once(process, 'message');
  }, { directory: process.argv[1] || undefined, onWait: () => process.send('queued') });
  process.disconnect();
`

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'orca-check-slot-'))
  directories.push(root)
  const first = join(root, 'worktree-a')
  const second = join(root, 'worktree-b')
  await Promise.all([mkdir(first), mkdir(second)])
  return { root, directory: join(root, 'host-checks'), first, second }
}

function start(directory, cwd, env = {}) {
  const child = spawnProcess({
    program: process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath,
    args: ['--input-type=module', '-e', source, directory],
    cwd,
    env: { ...process.env, ...env, ORCA_LOCAL_CHECK_LEASE: '' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  })
  workers.push(child)
  return child
}

afterEach(async () => {
  await Promise.all(
    workers.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return
      }
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    })
  )
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

it('queues checks from other worktrees while nested scripts reuse the held reservation', async () => {
  const { directory, first, second } = await setup()
  const holder = start(directory, first)
  expect((await once(holder, 'message'))[0]).toBe('running')
  const waiter = start(directory, second)
  expect((await once(waiter, 'message'))[0]).toBe('queued')
  const admitted = once(waiter, 'message')
  const exited = once(holder, 'exit')
  holder.send('finish')
  expect(await exited).toEqual([0, null])
  expect((await admitted)[0]).toBe('running')
  const done = once(waiter, 'exit')
  waiter.send('finish')
  expect(await done).toEqual([0, null])
})

it('reclaims a reservation after its process is killed', async () => {
  const { directory, first, second } = await setup()
  const holder = start(directory, first)
  expect((await once(holder, 'message'))[0]).toBe('running')
  const exited = once(holder, 'exit')
  holder.kill('SIGKILL')
  await exited
  const replacement = start(directory, second)
  expect((await once(replacement, 'message'))[0]).toBe('running')
  const done = once(replacement, 'exit')
  replacement.send('finish')
  expect(await done).toEqual([0, null])
})

it('coordinates the same user across different temporary directories', async () => {
  const { root, first, second } = await setup()
  const home = { HOME: root, USERPROFILE: root }
  const holder = start('', first, { ...home, TMPDIR: first, TMP: first, TEMP: first })
  expect((await once(holder, 'message'))[0]).toBe('running')
  const waiter = start('', second, { ...home, TMPDIR: second, TMP: second, TEMP: second })
  expect((await once(waiter, 'message'))[0]).toBe('queued')
  const admitted = once(waiter, 'message')
  const exited = once(holder, 'exit')
  holder.send('finish')
  await exited
  expect((await admitted)[0]).toBe('running')
  const done = once(waiter, 'exit')
  waiter.send('finish')
  expect(await done).toEqual([0, null])
})

it('releases a failed check before another check in the same process starts', async () => {
  const { directory } = await setup()
  await expect(
    withLocalCheckSlot(() => Promise.reject(new Error('compiler failed')), { directory, env: {} })
  ).rejects.toThrow('compiler failed')
  await expect(
    withLocalCheckSlot(() => 42, {
      directory,
      env: {},
      onWait: () => {
        throw new Error('Failed check retained its reservation')
      }
    })
  ).resolves.toBe(42)
})

it('finishes a no-change check without waiting for another check group', async () => {
  const { root, first } = await setup()
  const home = { HOME: root, USERPROFILE: root }
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'test@example.com'],
    ['config', 'user.name', 'Test'],
    ['config', 'commit.gpgsign', 'false']
  ]) {
    expect(runProcessSync({ program: 'git', args, cwd: first }).code).toBe(0)
  }
  await writeFile(join(first, 'tracked.txt'), 'baseline\n')
  expect(runProcessSync({ program: 'git', args: ['add', '.'], cwd: first }).code).toBe(0)
  expect(runProcessSync({ program: 'git', args: ['commit', '-qm', 'base'], cwd: first }).code).toBe(
    0
  )
  const holder = start('', first, home)
  expect((await once(holder, 'message'))[0]).toBe('running')
  const controller = new AbortController()
  const result = await runProcess({
    program: process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath,
    args: [changedCheckScript, '--base=HEAD'],
    cwd: first,
    env: { ...process.env, ...home, ORCA_LOCAL_CHECK_LEASE: '' },
    signal: controller.signal,
    onStderr: () => controller.abort()
  })
  expect(result.code, result.stderr).toBe(0)
})

it('cancels a queued check without running it or retaining a reservation', async () => {
  const { directory } = await setup()
  let release
  let entered
  const ready = new Promise((resolve) => {
    entered = resolve
  })
  const holder = withLocalCheckSlot(
    () =>
      new Promise((resolve) => {
        release = resolve
        entered()
      }),
    { directory, env: {} }
  )
  await ready
  const controller = new AbortController()
  try {
    await expect(
      withLocalCheckSlot(
        () => {
          throw new Error('Cancelled check started')
        },
        {
          directory,
          env: {},
          signal: controller.signal,
          onWait: () => controller.abort()
        }
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
  } finally {
    release()
    await holder
  }
  await expect(withLocalCheckSlot(() => 42, { directory, env: {} })).resolves.toBe(42)
})

it('honors cancellation while inheriting an active reservation', async () => {
  const { directory } = await setup()
  const env = {}
  await withLocalCheckSlot(
    async () => {
      const controller = new AbortController()
      const check = withLocalCheckSlot(
        () => {
          throw new Error('Cancelled check started')
        },
        {
          directory,
          env,
          signal: controller.signal
        }
      )
      controller.abort()
      await expect(check).rejects.toMatchObject({ name: 'AbortError' })
    },
    { directory, env }
  )
})

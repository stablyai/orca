import { once } from 'node:events'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import { afterEach, expect, it } from 'vitest'
import { withLocalCheckSlot } from './local-check-slot.mjs'

const workers = []
const directories = []
const slotModule = new URL('./local-check-slot.mjs', import.meta.url).href
const source = `
  import { once } from 'node:events';
  import { withLocalCheckSlot } from ${JSON.stringify(slotModule)};
  await withLocalCheckSlot(async () => {
    await withLocalCheckSlot(async () => {});
    process.send('running');
    await once(process, 'message');
  }, { directory: process.argv[1], onWait: () => process.send('queued') });
  process.disconnect();
`

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'orca-check-slot-'))
  directories.push(root)
  const first = join(root, 'worktree-a')
  const second = join(root, 'worktree-b')
  await Promise.all([mkdir(first), mkdir(second)])
  return { directory: join(root, 'host-checks'), first, second }
}

function start(directory, cwd) {
  const child = spawnProcess({
    program: process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath,
    args: ['--input-type=module', '-e', source, directory],
    cwd,
    env: { ...process.env, ORCA_LOCAL_CHECK_LEASE: '' },
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

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.platform !== 'win32') {
  throw new Error('Run the native watcher gate on Windows')
}
const require = createRequire(import.meta.url)
const binary = resolve(process.argv[2] ?? `.build/windows-watcher/${process.arch}/watcher.node`)
const { createWrapper } = require('@parcel/watcher/wrapper.js')
const watcher = createWrapper(require(binary))
const root = await mkdtemp(join(tmpdir(), 'orca-watcher-readiness-'))
const subscriptions = new Set()

async function subscribe(directory) {
  let deliver
  const received = new Promise((resolveEvent, rejectEvent) => {
    deliver = (error, events) => {
      if (error) {
        rejectEvent(error)
      } else if (
        events.some((event) => event.type === 'create' && event.path === join(directory, 'first'))
      ) {
        resolveEvent()
      }
    }
  })
  // A native error may precede the registration acknowledgement.
  void received.catch(() => {})
  const subscription = await watcher.subscribe(directory, deliver)
  subscriptions.add(subscription)
  return { subscription, received }
}

async function waitForEvent(received) {
  let timer
  try {
    await Promise.race([
      received,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Immediate create event was lost')), 10_000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function unsubscribe(subscription) {
  await subscription.unsubscribe()
  subscriptions.delete(subscription)
}

try {
  await assert.rejects(watcher.subscribe(join(root, 'missing'), () => {}))
  for (let round = 0; round < 12; round++) {
    const directories = await Promise.all(
      Array.from({ length: 4 }, async (_, index) => {
        const directory = join(root, `${round}-${index}`)
        await mkdir(directory)
        return directory
      })
    )
    const watched = await Promise.all(directories.map(subscribe))
    // No retry, delayed write, or probe file may hide an unarmed native subscription.
    await Promise.all(directories.map((directory) => writeFile(join(directory, 'first'), 'ready')))
    await Promise.all(watched.map(({ received }) => waitForEvent(received)))
    await Promise.all(watched.map(({ subscription }) => unsubscribe(subscription)))
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true })))
  }

  const shared = join(root, 'shared')
  await mkdir(shared)
  const watchers = await Promise.all([subscribe(shared), subscribe(shared)])
  await writeFile(join(shared, 'first'), 'ready')
  await Promise.all(watchers.map(({ received }) => waitForEvent(received)))
  await Promise.all(watchers.map(({ subscription }) => unsubscribe(subscription)))
  console.log(`Watcher readiness passed: ${process.arch}, ${process.versions.bun ? 'Bun' : 'Node'}`)
} finally {
  await Promise.all([...subscriptions].map(unsubscribe))
  await rm(root, { recursive: true, force: true })
}

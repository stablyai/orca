import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import type { Dirent, Stats } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WslTranscriptFsProcessClient } from './wsl-transcript-fs-process-client'
import { forkWslTranscriptFsProcess } from './wsl-transcript-fs-process-spawn'

async function waitForExit(child: ReturnType<typeof forkWslTranscriptFsProcess>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (child.exitCode === null && child.signalCode === null) {
    assert(Date.now() < deadline, 'Transcript child did not exit')
    await delay(10)
  }
}

async function verify(): Promise<void> {
  const children: ReturnType<typeof forkWslTranscriptFsProcess>[] = []
  const client = new WslTranscriptFsProcessClient(() => {
    const child = forkWslTranscriptFsProcess()
    children.push(child)
    return child
  })
  const path = join(__dirname, 'binary transcript')
  const bytes = Buffer.from([0, 255, 10, 65])
  await writeFile(path, bytes)
  // Production callers have a live server; the client intentionally unrefs idle children.
  const keepAlive = setInterval(() => {}, 1_000)
  const signal = AbortSignal.timeout(10_000)
  try {
    const stat = await client.run<Stats>({ operation: 'stat', path }, signal)
    assert.equal(stat.isFile(), true)
    assert.equal(stat.size, bytes.length)
    const entries = await client.run<Dirent[]>({ operation: 'readdir', path: __dirname }, signal)
    assert(entries.some((entry) => entry.name === 'binary transcript' && entry.isFile()))
    const handle = await client.open(path, signal)
    const actual = await client.read(handle, 0, bytes.length, signal)
    assert(Buffer.isBuffer(actual))
    assert.deepEqual(actual, bytes)
    await client.close(handle)
    assert.equal(children.length, 1)

    const controller = new AbortController()
    const pending = client.run({ operation: 'stat', path }, controller.signal)
    controller.abort(new Error('cancel transcript read'))
    await assert.rejects(pending, /cancel transcript read/)
    await waitForExit(children[0])
    assert.equal(await client.run<boolean>({ operation: 'access', path }, signal), true)
    assert.equal(children.length, 2)

    children[1].kill('SIGKILL')
    await waitForExit(children[1])
    assert.equal(await client.run<boolean>({ operation: 'access', path }, signal), true)
    assert.equal(children.length, 3)
  } finally {
    client.dispose()
    try {
      await Promise.all(children.map(waitForExit))
    } finally {
      clearInterval(keepAlive)
    }
  }
  console.log('Bun transcript IPC, cancellation, replacement and disposal passed')
}

void verify().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})

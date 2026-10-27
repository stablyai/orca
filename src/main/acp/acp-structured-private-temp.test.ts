import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { GROK, openAcpAdapterRig } from './acp-structured-adapter.test-support'

const ownedDirectories = new Set<string>()

afterEach(async () => {
  try {
    await closeProviderTimelineRigs()
  } finally {
    await Promise.all(
      [...ownedDirectories].map((directory) => rm(directory, { recursive: true, force: true }))
    )
    ownedDirectories.clear()
  }
})

it('gives each process its own temp folder, removed at exit, and clears an earlier run at the first start', async () => {
  // Short enough that a socket under the run folder fits, so the root stays in the data folder.
  const dataDirectory = await mkdtemp(
    process.platform === 'win32' ? join(tmpdir(), 'orca-acp-temp-') : '/tmp/oa-'
  )
  ownedDirectories.add(dataDirectory)
  const root = join(dataDirectory, 'acp-temp', 'grok')
  const leftover = join(root, 'run-earlier-host', 'bundle')
  await mkdir(leftover, { recursive: true })
  const rig = await openAcpAdapterRig({
    spec: { ...GROK, privateTempDirectory: true },
    deps: { dataDirectory }
  })
  await rig.acquire()
  const { env } = rig.child().launch
  expect(existsSync(leftover)).toBe(false)
  expect(dirname(env?.TMPDIR ?? '')).toBe(root)
  expect([env?.TEMP, env?.TMP]).toEqual([env?.TMPDIR, env?.TMPDIR])
  expect(existsSync(env?.TMPDIR ?? '')).toBe(true)
  rig.child().exit()
  await vi.waitFor(() => expect(existsSync(env?.TMPDIR ?? '')).toBe(false))
})

it.skipIf(process.platform === 'win32')(
  'binds a socket under a relocated root and preserves live runs when starting another process',
  async () => {
    const base = await mkdtemp('/tmp/oa-')
    ownedDirectories.add(base)
    const dataDirectory = join(base, '界'.repeat(6))
    const legacyRoot = join(dataDirectory, 'acp-temp', 'grok')
    const legacyLeftover = join(legacyRoot, 'run-earlier-build', 'bundle')
    await mkdir(legacyLeftover, { recursive: true })
    const rig = await openAcpAdapterRig({
      spec: { ...GROK, privateTempDirectory: true },
      deps: { dataDirectory }
    })
    await rig.acquire()
    const { env } = rig.child().launch
    const run = env?.TMPDIR
    if (!run) {
      throw new Error('The child has no private temp folder')
    }
    expect(dirname(dirname(run))).toBe(`/tmp/oacp-${process.getuid?.()}`)
    ownedDirectories.add(dirname(run))
    expect([env?.TEMP, env?.TMP]).toEqual([env?.TMPDIR, env?.TMPDIR])
    expect(existsSync(legacyLeftover)).toBe(false)

    const socketPath = join(run, 'x'.repeat(56))
    expect(Buffer.byteLength(socketPath)).toBeLessThanOrEqual(
      process.platform === 'darwin' ? 103 : 107
    )
    const server = createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, resolve)
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }

    await mkdir(legacyLeftover, { recursive: true })
    const second = await openAcpAdapterRig({
      spec: { ...GROK, privateTempDirectory: true },
      deps: { dataDirectory }
    })
    await second.acquire()
    const secondRun = second.child().launch.env?.TMPDIR ?? ''
    expect(dirname(secondRun)).toBe(dirname(run))
    expect(secondRun).not.toBe(run)
    expect(existsSync(legacyLeftover)).toBe(true)
    expect(existsSync(run)).toBe(true)
    rig.child().exit()
    await vi.waitFor(() => expect(existsSync(run)).toBe(false))
    expect(existsSync(secondRun)).toBe(true)
    second.child().exit()
    await vi.waitFor(() => expect(existsSync(secondRun)).toBe(false))
  }
)

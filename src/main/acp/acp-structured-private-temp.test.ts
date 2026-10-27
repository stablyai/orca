import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { GROK, openAcpAdapterRig } from './acp-structured-adapter.test-support'
import { acpTempRoot } from './acp-private-temp'

const ownedDirectories = new Set<string>()

afterEach(async () => {
  try {
    await closeProviderTimelineRigs()
  } finally {
    await Promise.all(
      [...ownedDirectories].map((directory) => rm(directory, { recursive: true, force: true }))
    )
    ownedDirectories.clear()
    // Remove the per-user short folder only when no other Orca run left anything in it.
    await rmdir(`/tmp/oacp-${process.getuid?.() ?? 0}`).catch(() => undefined)
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
  'moves a root too long for a socket to a short private folder, clears the old root once, and removes the run at exit',
  async () => {
    const base = await mkdtemp('/tmp/oa-')
    const dataDirectory = join(base, 'd'.repeat(70))
    const legacyRoot = join(dataDirectory, 'acp-temp', 'grok')
    const legacyLeftover = join(legacyRoot, 'run-earlier-build', 'bundle')
    await mkdir(legacyLeftover, { recursive: true })
    const shortRoot = acpTempRoot(legacyRoot)
    ownedDirectories.add(base)
    ownedDirectories.add(shortRoot)
    expect(shortRoot).not.toBe(legacyRoot)
    const rig = await openAcpAdapterRig({
      spec: { ...GROK, privateTempDirectory: true },
      deps: { dataDirectory }
    })
    await rig.acquire()
    const { env } = rig.child().launch
    expect(dirname(env?.TMPDIR ?? '')).toBe(shortRoot)
    expect([env?.TEMP, env?.TMP]).toEqual([env?.TMPDIR, env?.TMPDIR])
    expect(existsSync(legacyLeftover)).toBe(false)
    rig.child().exit()
    await vi.waitFor(() => expect(existsSync(env?.TMPDIR ?? '')).toBe(false))
  }
)

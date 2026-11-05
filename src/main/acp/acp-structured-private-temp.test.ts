import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
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
  const dataDirectory = await mkdtemp(join(tmpdir(), 'orca-acp-temp-'))
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

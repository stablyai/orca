import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { publishHermesSessionToolEnv } from './hermes-session-tool-env'

let home: string
const file = () => join(home, 'plugins', 'orca-status', 'sessions', 'local-abc.json')
const publish = (token: string, live: () => boolean) =>
  publishHermesSessionToolEnv({
    env: { HERMES_HOME: home },
    providerSessionId: 'local-abc',
    values: { ORCA_AGENT_SESSION_TOOL_TOKEN: token },
    live
  })

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'orca-hermes-session-env-'))
  await mkdir(join(home, 'plugins', 'orca-status'), { recursive: true })
  await writeFile(join(home, 'plugins', 'orca-status', '__init__.py'), '')
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('publishHermesSessionToolEnv', () => {
  it("never lets an ended child's write or removal take a reopened chat's file", async () => {
    let oldLive = true
    const withdrawOld = await publish('old', () => oldLive)
    oldLive = false
    const withdrawNew = await publish('new', () => true)
    // The old child's write and its removal both land after the reopened chat published.
    await publish('late-old', () => oldLive)
    await withdrawOld()
    expect(JSON.parse(await readFile(file(), 'utf-8'))).toEqual({
      ORCA_AGENT_SESSION_TOOL_TOKEN: 'new'
    })

    await withdrawNew()
    await expect(readFile(file(), 'utf-8')).rejects.toThrow()
  })
})

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  createCrossVendorHandoffSeeds,
  withCrossVendorHandoffTurnContext
} from './cross-vendor-handoff-seeds'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

async function stateDirectory(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'orca-cross-vendor-'))
  folders.push(folder)
  return folder
}

const message: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'next question' }]
}

it('rides once ahead of the next turn, survives a restart, and is gone once the agent took it', async () => {
  const directory = await stateDirectory()
  await createCrossVendorHandoffSeeds(directory).put('session-0001', 'EARLIER CONVERSATION')
  // A new host process reads the seed the old one left on disk.
  const seeds = createCrossVendorHandoffSeeds(directory)
  let innerGiven = 0
  const context = withCrossVendorHandoffTurnContext(
    {
      plan: async (_sessionId, _message, _held, clientMessageId) => ({
        text: clientMessageId === 'look-around-opener' ? 'BOT RULES WITH IDLE ITEMS' : 'BOT RULES',
        given: () => {
          innerGiven++
        }
      })
    },
    seeds
  )
  const plan = await context.plan('session-0001', message, null, 'look-around-opener')
  expect(plan?.text).toBe('EARLIER CONVERSATION\n\nBOT RULES WITH IDLE ITEMS')
  // Refused or unanswered turns keep owing the context.
  expect((await context.plan('session-0001', message))?.text).toContain('EARLIER CONVERSATION')
  plan?.given({ instructionsRecorded: false })
  expect(innerGiven).toBe(1)
  expect((await context.plan('session-0001', message))?.text).toBe('BOT RULES')
  await vi.waitFor(async () =>
    expect(await createCrossVendorHandoffSeeds(directory).read('session-0001')).toBeNull()
  )
  expect(await context.plan('session-0002', message)).toMatchObject({ text: 'BOT RULES' })
})

it('refuses session ids that could name a file outside its folder', async () => {
  const seeds = createCrossVendorHandoffSeeds(await stateDirectory())
  await expect(seeds.put('../../escape', 'x')).rejects.toThrow('invalid session id')
  expect(await seeds.read('..\\..\\escape')).toBeNull()
})

it('refuses to plan a turn when saved conversation context is temporarily unreadable', async () => {
  const directory = await stateDirectory()
  const sessionId = 'session-0001'
  const path = join(directory, 'cross-vendor-handoffs', `${sessionId}.txt`)
  await mkdir(path, { recursive: true })
  const context = withCrossVendorHandoffTurnContext(
    undefined,
    createCrossVendorHandoffSeeds(directory)
  )
  await expect(context.plan(sessionId, message)).rejects.toThrow()
  await rm(path, { recursive: true })
  await createCrossVendorHandoffSeeds(directory).put(sessionId, 'Restored conversation')
  expect((await context.plan(sessionId, message))?.text).toBe('Restored conversation')
})

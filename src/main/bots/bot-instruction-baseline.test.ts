import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../shared/agent-session/journal/agent-session-journal-types'
import { codexProviderHandle } from '../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { recordStartedHandle } from '../native-chat/agent-session-wire/startup/structured-agent-session-start-provider-answer'
import { withInstructionBaselinePersistence } from '../native-chat/agent-session-wire/structured-agent-session-instruction-baseline'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { installCodexBotInstructions } from '../codex/structured/threads/codex-bot-instruction-installation'
import {
  store,
  reopenInstallationStore,
  seedInstallationRecord,
  NOW
} from '../codex/structured/threads/codex-bot-instruction-installation.test-support'
import { createBotTurnContext } from './bot-turn-context'
import { botSessionInstructions } from './bot-session-instructions'
import { TAKEN } from './bot-turn-rules.test-fixture'

const FOLDER = '/isolated/release'
const OWNER = {
  kind: 'message' as const,
  role: 'user' as const,
  blocks: [{ type: 'text' as const, text: 'owner task' }]
}
const logger = createStructuredAgentSessionLogger()
let files: Map<string, string>
let journal: AgentJournalRenderItem[]
let generation: number

beforeEach(() => {
  files = new Map([
    [join(FOLDER, 'SOUL.md'), 'Be brief.'],
    [join(FOLDER, 'MEMORY.md'), '- first fact']
  ])
  journal = []
  generation = 0
})

function context() {
  const fs = {
    readText: async (path: string) => files.get(path) ?? null,
    writeText: async (path: string, text: string) => {
      files.set(path, text)
      return true
    },
    replaceText: async (path: string, expected: string, text: string) => {
      if (files.get(path) !== expected) {
        return false
      }
      files.set(path, text)
      return true
    }
  }
  const bot = createBotTurnContext(fs)
  const wrapped = withInstructionBaselinePersistence(
    bot,
    {
      getRecord: (id) => store.getRecord(id),
      updateRecord: (id, command) => store.updateRecord(id, command)
    },
    (work) => work,
    logger
  )!
  const open = async (
    fresh = false,
    historyUnchanged = true,
    request = vi.fn(async () => ({}))
  ) => {
    await botSessionInstructions(
      bot,
      [
        {
          id: 'release-manager',
          name: 'Release Manager',
          agent: 'codex',
          folderWorkspaceId: 'release'
        }
      ],
      { ...store.getRecord('release-chat')!, instructionsEachStart: false },
      FOLDER,
      null,
      fs
    )
    const snapshot = bot.instructionSnapshot!('release-chat')!
    const fence = store.getRecord('release-chat')!.lease.runtimeFence
    const currentGeneration = `generation-${++generation}`
    const link = {
      linkId: `opened-${generation}`,
      handle: codexProviderHandle('native-release'),
      origin: fresh ? ('created' as const) : ('resumed' as const),
      mintedAtFence: fence,
      observedAt: NOW
    }
    const installed = await installCodexBotInstructions({
      installation: { store, snapshot, account: '/isolated/codex' },
      connection: { request },
      sessionId: 'release-chat',
      nativeId: 'native-release',
      generation: currentGeneration,
      anchor: link.linkId,
      fence,
      fresh,
      historyUnchanged,
      signal: new AbortController().signal,
      assertCurrent: () => {}
    })
    expect(
      await recordStartedHandle(
        { deps: { store, turnContext: wrapped, logger }, now: () => NOW },
        {
          sessionId: 'release-chat',
          fence,
          acquisitionGeneration: currentGeneration,
          link,
          reportedOptions: {},
          instructionPolicy: installed.policy,
          instructionContext: {
            account: '/isolated/codex',
            digest: snapshot.digest,
            filesIncluded: installed.filesIncluded
          }
        }
      )
    ).toBe(true)
    return { installed, request }
  }
  const plan = () =>
    wrapped.plan('release-chat', OWNER, store.getRecord('release-chat')?.instructionsKey ?? null)
  const turn = async (edit?: () => void) => {
    wrapped.handedOver?.('release-chat', OWNER)
    await (await plan())?.given(TAKEN)
    edit?.()
    const bodies: AgentJournalItemBody[] = [
      OWNER,
      ...(edit
        ? [
            {
              kind: 'tool-call' as const,
              name: 'Edit',
              input: { file_path: join(FOLDER, 'SOUL.md'), new_string: 'own soul' },
              state: 'completed' as const
            },
            {
              kind: 'tool-call' as const,
              name: 'Edit',
              input: { file_path: join(FOLDER, 'MEMORY.md'), new_string: 'own fact' },
              state: 'completed' as const
            }
          ]
        : [])
    ]
    for (const body of bodies) {
      journal.push({
        itemId: `row-${journal.length}`,
        sequence: journal.length + 1,
        revision: 1,
        observedAt: NOW,
        body
      })
    }
    await wrapped.turnEnded?.('release-chat', 'turn-1', async () => ({
      items: journal,
      openerIds: new Map()
    }))
  }
  return { open, plan, turn, wrapped }
}

it('reuses the proven unchanged dynamic baseline across reacquisition and a store/context reopen', async () => {
  const first = context()
  await first.open(true)
  expect(await first.plan()).toBeNull()
  expect((await first.open()).request.mock.calls).toEqual([])
  expect(await first.plan()).toBeNull()
  await reopenInstallationStore()
  const reopened = context()
  expect((await reopened.open()).request.mock.calls).toEqual([])
  expect(await reopened.plan()).toBeNull()
})

it('keeps newer edits pending across refusal/reopen and saves only the accepted plan', async () => {
  const first = context()
  await first.open(true)
  files.set(join(FOLDER, 'SOUL.md'), 'Ask before deployment.')
  files.set(join(FOLDER, 'MEMORY.md'), '- second fact\n- first fact')
  expect((await first.plan())?.text).toContain('Ask before deployment.')
  await reopenInstallationStore()
  const reopened = context()
  expect((await reopened.open()).request.mock.calls).toEqual([])
  const pending = await reopened.plan()
  expect(pending?.text).toContain('Ask before deployment.')
  expect(pending?.text).toContain('second fact')
  expect(pending?.note).toMatchObject({
    presentation: 'bot-context',
    botContext: { botId: 'release-manager', changed: ['soul', 'memory'] }
  })
  expect((await reopened.plan())?.text).toContain('second fact')
  await pending?.given(TAKEN)
  expect(await reopened.plan()).toBeNull()
  await reopenInstallationStore()
  const again = context()
  await again.open()
  expect(await again.plan()).toBeNull()
})

it('persists the existing own-writer baseline rather than restoring the original installation after reopen', async () => {
  const first = context()
  await first.open(true)
  await first.turn()
  await first.turn(() => {
    files.set(join(FOLDER, 'SOUL.md'), 'My own soul edit.')
    files.set(join(FOLDER, 'MEMORY.md'), '- own fact\n- first fact')
  })
  expect(await first.plan()).toBeNull()
  await reopenInstallationStore()
  const reopened = context()
  expect((await reopened.open()).request.mock.calls).toEqual([])
  expect(await reopened.plan()).toBeNull()
  files.set(join(FOLDER, 'SOUL.md'), 'New owner edit after reopen.')
  expect((await reopened.plan())?.text).toContain('New owner edit after reopen.')
})

it('a late accepted plan cannot overwrite a replacement generation baseline', async () => {
  const first = context()
  await first.open(true)
  files.set(join(FOLDER, 'SOUL.md'), 'Old pending edit.')
  const late = await first.plan()
  files.set(join(FOLDER, 'SOUL.md'), 'Replacement policy.')
  await first.open()
  await late?.given(TAKEN)
  const pending = await first.plan()
  expect(pending?.text).toContain('Replacement policy.')
  await reopenInstallationStore()
  const reopened = context()
  await reopened.open()
  expect((await reopened.plan())?.text).toContain('Replacement policy.')
})

it('repairs a legacy receipt without a proved baseline instead of declaring current files delivered', async () => {
  const first = context()
  await first.open(true)
  await seedInstallationRecord((record) => ({
    ...record,
    instructionPolicy: { ...record.instructionPolicy!, baseline: undefined }
  }))
  await reopenInstallationStore()
  const reopened = context()
  const result = await reopened.open()
  expect(result.installed.filesIncluded).toBe(true)
  expect(result.request.mock.calls.length).toBe(1)
  expect(await reopened.plan()).toBeNull()
})

describe.each([
  { path: 'normal', historyUnchanged: true, filesIncluded: false, cold: false },
  { path: 'recovery', historyUnchanged: false, filesIncluded: true, cold: false },
  { path: 'cold full repair', historyUnchanged: false, filesIncluded: true, cold: true }
])('$path resume after idle changes', ({ historyUnchanged, filesIncluded, cold }) => {
  it.each([
    {
      file: 'SOUL',
      edits: [['SOUL.md', 'Ask before deployment.']],
      changed: ['soul'],
      carried: ['Ask before deployment.']
    },
    {
      file: 'MEMORY',
      edits: [['MEMORY.md', '- second fact\n- first fact']],
      changed: ['memory'],
      carried: ['second fact']
    },
    {
      file: 'SOUL and MEMORY',
      edits: [
        ['SOUL.md', 'Ask before deployment.'],
        ['MEMORY.md', '- second fact\n- first fact']
      ],
      changed: ['soul', 'memory'],
      carried: ['Ask before deployment.', 'second fact']
    }
  ])(
    'keeps the owner edit of $file pending until its turn is accepted',
    async ({ edits, changed, carried }) => {
      const first = context()
      await first.open(true)
      for (const [file, text] of edits) {
        files.set(join(FOLDER, file), text)
      }
      if (cold) {
        await reopenInstallationStore()
      }
      const repairing = cold ? context() : first
      const result = await repairing.open(false, historyUnchanged)
      expect(result.installed.filesIncluded).toBe(filesIncluded)
      const pending = await repairing.plan()
      expect(pending?.note).toMatchObject({
        presentation: 'bot-context',
        botContext: { botId: 'release-manager', changed }
      })
      for (const text of carried) {
        expect(pending?.text).toContain(text)
      }

      await reopenInstallationStore()
      const reopened = context()
      await reopened.open()
      const restored = await reopened.plan()
      expect(restored?.note).toMatchObject({
        presentation: 'bot-context',
        botContext: { botId: 'release-manager', changed }
      })
      await restored?.given(TAKEN)
      expect(await reopened.plan()).toBeNull()
      await reopenInstallationStore()
      const accepted = context()
      await accepted.open()
      expect(await accepted.plan()).toBeNull()
    }
  )

  it('keeps the actual own-writer baseline through repair and reopen', async () => {
    const first = context()
    await first.open(true)
    await first.turn()
    await first.turn(() => {
      files.set(join(FOLDER, 'SOUL.md'), 'My own soul edit.')
      files.set(join(FOLDER, 'MEMORY.md'), '- own fact\n- first fact')
    })
    if (cold) {
      await reopenInstallationStore()
    }
    const repairing = cold ? context() : first
    const result = await repairing.open(false, historyUnchanged)
    expect(result.installed.filesIncluded).toBe(filesIncluded)
    expect(await repairing.plan()).toBeNull()
    await reopenInstallationStore()
    const reopened = context()
    await reopened.open()
    expect(await reopened.plan()).toBeNull()
  })
})

it('adds no file-change note when a cold full repair carries unchanged files', async () => {
  const first = context()
  await first.open(true)
  await reopenInstallationStore()
  const repairing = context()
  const result = await repairing.open(false, false)
  expect(result.installed.filesIncluded).toBe(true)
  expect(await repairing.plan()).toBeNull()
  await reopenInstallationStore()
  const reopened = context()
  await reopened.open()
  expect(await reopened.plan()).toBeNull()
})

it('cold full repair preserves comparison through failed delivery and another cold open', async () => {
  const first = context()
  await first.open(true)
  const prior = store.getRecord('release-chat')!.instructionPolicy!
  files.set(join(FOLDER, 'SOUL.md'), 'Earlier outside edit.')
  await reopenInstallationStore()
  await expect(
    context().open(
      false,
      false,
      vi.fn(async () => {
        throw new Error('reply lost after append')
      })
    )
  ).rejects.toMatchObject({ fact: { instructionRecovery: 'unknown' } })
  expect(store.getRecord('release-chat')!.instructionPolicy).toMatchObject({
    state: 'pending',
    baseline: prior.baseline,
    comparisonAnchor: prior.anchor
  })
  files.set(join(FOLDER, 'MEMORY.md'), '- Later outside edit\n- first fact')
  await seedInstallationRecord((record) => ({
    ...record,
    instructionPolicy: { ...record.instructionPolicy!, state: 'released' },
    lease: {
      ...record.lease,
      deathEvidence: {
        kind: 'exit-observed',
        detail: 'test writer exit',
        observedAt: NOW,
        ownerFence: record.instructionPolicy!.fence
      }
    }
  }))
  const repairing = context()
  await repairing.open(false, false)
  const plan = await repairing.plan()
  expect(plan?.note).toMatchObject({ botContext: { changed: ['soul', 'memory'] } })
  expect(plan?.text).toContain('Later outside edit')
  await plan?.given(TAKEN)
  await reopenInstallationStore()
  const settled = context()
  await settled.open()
  expect(await settled.plan()).toBeNull()
})

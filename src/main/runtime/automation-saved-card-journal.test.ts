import { afterEach, expect, it } from 'vitest'
import type { Automation } from '../../shared/automations/automation-definition'
import { testOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address-test-fixture'
import { projectStructuredOrcaCardItem } from '../../shared/structured-automation-saved-projection'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig.test-fixture'
import { eventually } from '../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import {
  hostTestAttachParams,
  hostTestOperationId
} from '../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { recordAutomationSavedCard } from './automation-saved-card'
import { appendOrcaChatCard } from './orca-chat-card'

const CHAT = testOrcaSessionId('automation-card-chat')
let rig: QueuedMessageTestRig | undefined
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig?.dispose()
  rig = undefined
})

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the card reads only these fields.
const SAVED = {
  id: 'auto-1',
  name: 'Morning digest',
  enabled: true,
  nextRunAt: 2_000,
  updatedAt: 1_500,
  dtstart: 1_000,
  rrule: 'FREQ=DAILY',
  workspaceId: 'folder:fw-1',
  bot: { botId: 'bot-1', runsIn: 'chat', resultsTo: 'chat' }
} as Automation

it('records one card per saved version in the chat, which projects to the automation card', async () => {
  rig = await createQueuedMessageTestRig()
  const { host } = rig
  setStructuredAgentSessionHost(host)
  expect(
    await host.attach(
      QUEUED_RIG_CALLER,
      hostTestAttachParams(null, {
        envelope: {
          sessionId: CHAT,
          clientOperationId: hostTestOperationId(),
          expectedRuntimeFence: null,
          payloadFingerprint: ''
        }
      })
    )
  ).toMatchObject({ ok: true })
  const cards = async () =>
    (
      await (await host.journalReads(CHAT)).operationWindow({ afterSequence: 0 })
    ).snapshot.items.filter((item) => item.body.kind === 'automation-saved')

  recordAutomationSavedCard(CHAT, 'created', SAVED)
  await eventually(async () => expect(await cards()).toHaveLength(1))
  // A repeat of the same version adds nothing; an edit adds its own card.
  recordAutomationSavedCard(CHAT, 'created', SAVED)
  recordAutomationSavedCard(CHAT, 'updated', { ...SAVED, updatedAt: 1_600, enabled: false })
  await eventually(async () => expect(await cards()).toHaveLength(2))

  const [created, updated] = (await cards()).map(projectStructuredOrcaCardItem)
  expect(created).toMatchObject({
    role: 'system',
    blocks: [],
    automationSaved: {
      change: 'created',
      automation: { id: 'auto-1', name: 'Morning digest' },
      resultsTo: 'chat'
    }
  })
  expect(updated?.automationSaved).toMatchObject({
    change: 'updated',
    automation: { updatedAt: 1_600, enabled: false }
  })
})

it('records a tool the bot added in its chat, which projects to the tool card', async () => {
  rig = await createQueuedMessageTestRig()
  const { host } = rig
  setStructuredAgentSessionHost(host)
  await host.attach(
    QUEUED_RIG_CALLER,
    hostTestAttachParams(null, {
      envelope: {
        sessionId: CHAT,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: null,
        payloadFingerprint: ''
      }
    })
  )
  const tool = { name: 'notion', detail: 'https://mcp.notion.com/mcp', remote: true }
  appendOrcaChatCard(CHAT, { kind: 'tool-added', botId: 'bot-1', tool, addedAt: 5 }, 'test')
  const cards = async () =>
    (
      await (await host.journalReads(CHAT)).operationWindow({ afterSequence: 0 })
    ).snapshot.items.filter((item) => item.body.kind === 'tool-added')
  await eventually(async () => expect(await cards()).toHaveLength(1))
  expect(projectStructuredOrcaCardItem((await cards())[0]!)).toMatchObject({
    role: 'system',
    blocks: [],
    toolAdded: { botId: 'bot-1', tool, addedAt: 5 }
  })
})

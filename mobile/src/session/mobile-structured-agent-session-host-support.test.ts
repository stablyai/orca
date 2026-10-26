import { describe, expect, it } from 'vitest'
import { AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY } from '../../../src/shared/structured-agent-session-surface-capabilities'
import {
  AGENT_SESSION_ATTACHMENTS_RUNTIME_CAPABILITY,
  AGENT_SESSION_ITEM_DETAIL_RUNTIME_CAPABILITY,
  AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
  AGENT_SESSION_PHONE_ATTACHMENTS_RUNTIME_CAPABILITY,
  AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGE_EDIT_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGE_IMAGE_EDIT_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY,
  AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY,
  AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import { AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY } from '../../../src/shared/agent-session-create-capabilities'
import { AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY } from '../../../src/shared/agent-session-permission-modes-capability'
import { structuredAgentSessionHostSupport } from './mobile-structured-agent-session-host-support'

describe('structuredAgentSessionHostSupport', () => {
  it('reads each structured-session feature from the host capability list', () => {
    const none = {
      coherentModelCatalog: false,
      promptCancel: false,
      questionAnswers: false,
      queuedMessages: false,
      queuedCommands: false,
      queuedMessageEdit: false,
      queuedMessageImageEdit: false,
      quietRepeatedStop: false,
      statusFeed: false,
      sendOptions: false,
      conversationStop: false,
      permissionModes: false,
      permissionOwn: false,
      itemDetail: false,
      phoneAttachments: false
    }
    expect(structuredAgentSessionHostSupport([])).toEqual(none)
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY])
    ).toEqual({ ...none, coherentModelCatalog: true })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_QUESTION_ANSWERS_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, questionAnswers: true })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, promptCancel: true })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, queuedMessages: true })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_QUEUED_COMMANDS_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, queuedCommands: true })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_QUEUED_MESSAGE_EDIT_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, queuedMessageEdit: true })
    expect(
      structuredAgentSessionHostSupport([
        AGENT_SESSION_QUEUED_MESSAGE_IMAGE_EDIT_RUNTIME_CAPABILITY
      ])
    ).toEqual({ ...none, queuedMessageImageEdit: true })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, quietRepeatedStop: true })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, statusFeed: true })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, sendOptions: true })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, conversationStop: true })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_PERMISSION_MODES_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, permissionModes: true })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_PHONE_ATTACHMENTS_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, phoneAttachments: true })
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_ITEM_DETAIL_RUNTIME_CAPABILITY])
    ).toEqual({ ...none, itemDetail: true })
    // A host with the store but from before phones could upload into it offers them nothing.
    expect(
      structuredAgentSessionHostSupport([AGENT_SESSION_ATTACHMENTS_RUNTIME_CAPABILITY])
    ).toEqual(none)
  })
})

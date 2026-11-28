import { describe, expect, it } from 'vitest'
import { attachMobilePushPrompt } from '../../../shared/mobile-push-prompt'
import type { MobilePushPrompt } from '../../../shared/notifications/mobile-push-contract'
import type { PushSendNotification } from './push-gateway-client'
import { PushPromptCategoryGate } from './push-prompt-category-gate'
import {
  capturePushPrompt,
  notificationForSound,
  notificationWithAgentPrompt
} from './push-dispatcher-prompt'
import type { MobileNotificationEvent } from './notifications/runtime-mobile-notification-controller'

const prompt: MobilePushPrompt = {
  promptId: 'term:pty-1:0123456789abcdef0123',
  options: [
    { optionId: 'allow_once', label: 'Allow once', role: 'approve' },
    { optionId: 'reject_once', label: 'Reject', role: 'deny' }
  ]
}

const notification: PushSendNotification = {
  notificationSeq: 1,
  notificationEpoch: 'epoch-1',
  source: 'agent-task-complete',
  agentState: 'needs-input',
  title: 'Needs you',
  body: 'Bash'
}

const event: MobileNotificationEvent = {
  type: 'notification',
  source: 'agent-task-complete',
  title: 'Needs you',
  body: 'Bash',
  paneKey: 'pane-1'
}

function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('push prompt attachment', () => {
  it('keeps the prompt captured before a later one appears in the pane', async () => {
    let current: MobilePushPrompt | null = prompt
    const gate = new PushPromptCategoryGate(async () => true)
    const desktop = {
      gate,
      promptFor: () => current
    }
    capturePushPrompt(event, desktop)
    current = {
      ...prompt,
      promptId: 'term:pty-1:fedcba9876543210abcd'
    }
    gate.refresh()
    await flush()
    const attached = notificationWithAgentPrompt(notification, event, desktop)
    expect(attached.prompt?.promptId).toBe(prompt.promptId)
  })

  it('drops the prompt on a silent send that would pass 3000 bytes', () => {
    let body = 'x'
    let attached = notification
    while (body.length < 4000) {
      attached = attachMobilePushPrompt({ ...notification, body }, prompt, true)
      if (attached.prompt && bytes({ ...attached, sound: false }) > 3000) {
        break
      }
      body += 'x'
    }
    expect(attached.prompt?.promptId).toBe(prompt.promptId)
    expect(bytes(attached)).toBeLessThanOrEqual(3000)
    const silent = notificationForSound(attached, false)
    expect(silent).not.toHaveProperty('prompt')
    expect(bytes(silent)).toBeLessThanOrEqual(3000)
    expect(notificationForSound(attached, true)).toBe(attached)
  })
})

import { describe, expect, it } from 'vitest'
import {
  classifyMobileNativeChatSend,
  mobileNativeChatSendOpensAgentPicker
} from './mobile-native-chat-send-classification'

describe('classifyMobileNativeChatSend', () => {
  it('classifies catalog commands per agent', () => {
    expect(classifyMobileNativeChatSend('claude', '/clear')).toBe('command')
    expect(classifyMobileNativeChatSend('claude', '/compact')).toBe('command')
    expect(classifyMobileNativeChatSend('codex', '/model')).toBe('command')
    expect(classifyMobileNativeChatSend('codex', '/permissions')).toBe('command')
  })

  it('recognizes Claude /resume as a command, not an unknown token', () => {
    // STA-4617: it was absent from the Claude catalog, so the `/` menu never
    // offered it and a typed one could not claim a command ran.
    expect(classifyMobileNativeChatSend('claude', '/resume')).toBe('command')
  })

  it('treats slash tokens outside the agent catalog as unknown, never chat', () => {
    // `/model` is not a verified Claude command — it still dispatches to the
    // TUI, so it must not get a chat bubble, but it can't claim a command ran.
    expect(classifyMobileNativeChatSend('claude', '/model sonnet')).toBe('unknown-token')
    expect(classifyMobileNativeChatSend('claude', '/cost')).toBe('unknown-token')
    expect(classifyMobileNativeChatSend('claude', '/diff')).toBe('unknown-token')
  })

  it('keeps prose as chat, including leading-whitespace slash text', () => {
    expect(classifyMobileNativeChatSend('claude', 'hello there')).toBe('chat')
    expect(classifyMobileNativeChatSend('claude', ' /clear is a command')).toBe('chat')
    expect(classifyMobileNativeChatSend('claude', '/usr/bin/python is missing')).toBe(
      'unknown-token'
    )
  })

  it('treats $ tokens as skill grammar only for Codex', () => {
    expect(classifyMobileNativeChatSend('codex', '$deploy now')).toBe('unknown-token')
    expect(classifyMobileNativeChatSend('claude', '$PATH is empty')).toBe('chat')
  })

  it('defaults to chat when no agent is resolved', () => {
    expect(classifyMobileNativeChatSend(null, '/clear')).toBe('chat')
  })
})

describe('mobileNativeChatSendOpensAgentPicker', () => {
  it('is true for a command the agent answers with its own TUI picker', () => {
    expect(mobileNativeChatSendOpensAgentPicker('claude', '/resume')).toBe(true)
    expect(mobileNativeChatSendOpensAgentPicker('codex', '/resume')).toBe(true)
  })

  it('is false for chat prose and for commands answered inline', () => {
    expect(mobileNativeChatSendOpensAgentPicker('claude', '/clear')).toBe(false)
    expect(mobileNativeChatSendOpensAgentPicker('claude', 'resume the refactor')).toBe(false)
    expect(mobileNativeChatSendOpensAgentPicker('claude', ' /resume')).toBe(false)
  })

  it('is false without a resolved agent, and for an agent with no catalog', () => {
    expect(mobileNativeChatSendOpensAgentPicker(null, '/resume')).toBe(false)
    expect(mobileNativeChatSendOpensAgentPicker('grok', '/resume')).toBe(false)
  })
})

import {
  stableDeliveryId,
  stableExternalId,
  type DingTalkGroupSetup,
  type DingTalkInbound,
  type DingTalkSetup
} from './dingtalk-domain'

export type InboundDecision =
  | {
      kind: 'accept'
      binding: DingTalkGroupSetup
      body: string
      externalId: ReturnType<typeof stableExternalId>
      deliveryId: ReturnType<typeof stableDeliveryId>
    }
  | { kind: 'drop'; reason: 'unbound_group' | 'self_message' | 'empty' | 'trigger' | 'noise' }

function bodyAfterMention(content: string, names: readonly string[]): string {
  let text = content.trimStart()
  for (const name of names) {
    if (!text.startsWith(`@${name}`)) {
      continue
    }
    text = text.slice(name.length + 1).trimStart()
    if (text.startsWith('(')) {
      const close = text.indexOf(')')
      text = (close === -1 ? text.slice(1) : text.slice(close + 1)).trimStart()
    }
    break
  }
  return text
}

function noise(text: string): boolean {
  const core = [...text]
    .filter((char) => /[\p{L}\p{N}]/u.test(char))
    .join('')
    .toLowerCase()
  return (
    core.length === 0 || new Set(['好', '好的', '收到', 'ok', 'okay', '谢谢', '辛苦']).has(core)
  )
}

export function decideInbound(setup: DingTalkSetup, event: DingTalkInbound): InboundDecision {
  const binding = setup.groups.find(
    (group) => group.profile === event.profile && group.groupId === event.groupId
  )
  if (!binding) {
    return { kind: 'drop', reason: 'unbound_group' }
  }
  if (binding.selfOpenId && binding.selfOpenId === event.senderOpenId) {
    return { kind: 'drop', reason: 'self_message' }
  }
  const text = bodyAfterMention(event.content, binding.selfNames)
  if (binding.mode === 'at' && binding.requirePrefix) {
    if (!text.toLowerCase().startsWith(binding.prefix.toLowerCase())) {
      return { kind: 'drop', reason: 'trigger' }
    }
    const rest = text.slice(binding.prefix.length)
    if (rest && !/^\s/.test(rest)) {
      return { kind: 'drop', reason: 'trigger' }
    }
    const body = rest.trim()
    return body
      ? {
          kind: 'accept',
          binding,
          body,
          externalId: stableExternalId(event.profile, event.conversationId),
          deliveryId: stableDeliveryId(event.profile, event.messageId)
        }
      : { kind: 'drop', reason: 'empty' }
  }
  if (binding.noiseFilter && noise(text)) {
    return { kind: 'drop', reason: 'noise' }
  }
  const body = text.trim()
  return body
    ? {
        kind: 'accept',
        binding,
        body,
        externalId: stableExternalId(event.profile, event.conversationId),
        deliveryId: stableDeliveryId(event.profile, event.messageId)
      }
    : { kind: 'drop', reason: 'empty' }
}

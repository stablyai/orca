import { describe, expect, it } from 'vitest'
import { MOBILE_RPC_METHOD_ROUTES } from './runtime-rpc-mobile-method-routing'
import {
  BOTS_CREATE_RUNTIME_CAPABILITY,
  BOTS_MOBILE_RUNTIME_CAPABILITY
} from '../../../../shared/bot-runtime-capabilities'
import { RUNTIME_CAPABILITIES } from '../../../../shared/remote-runtime/protocol/protocol-version'
import { denyRpcMethodForCaller } from '../callers/rpc-caller-scope'

describe('mobile bot and automation routes', () => {
  it('are announced, so a page can tell an older host that lacks them', () => {
    expect(RUNTIME_CAPABILITIES).toContain(BOTS_MOBILE_RUNTIME_CAPABILITY)
    expect(RUNTIME_CAPABILITIES).toContain(BOTS_CREATE_RUNTIME_CAPABILITY)
  })

  it.each([
    'bots.list',
    'bots.avatar.read',
    'bots.chat.open',
    'bots.chat.reset',
    'bots.session.start',
    'bots.activity',
    'bots.update',
    'bots.access.list',
    'bots.access.decide',
    'bots.access.redeem',
    'bots.suggestions.start',
    'bots.suggestions.dismiss',
    'bots.lookAround.lookNow',
    'bots.create',
    'bots.upNext.seen',
    'bots.upNext.unseen',
    'bots.chats.own',
    'bots.chats.seen',
    'automation.list',
    'automation.runs',
    'automation.runNow',
    'automation.update'
  ])('runs %s on the host the bot or automation lives on', (method) => {
    expect(MOBILE_RPC_METHOD_ROUTES.get(method)).toBe('execution-host')
  })

  it('runs a phone’s item reads and changes on the bot’s own host, a paired server’s too', () => {
    for (const method of [
      'bots.items.owner.list',
      'bots.items.owner.show',
      'bots.items.owner.comment',
      'bots.items.owner.status',
      'bots.items.owner.opened'
    ]) {
      expect(MOBILE_RPC_METHOD_ROUTES.get(method)).toBe('execution-host')
      expect(
        denyRpcMethodForCaller({ kind: 'mobile', delegated: true }, method, 'workspace')
      ).toBeNull()
    }
  })

  it('admits a phone, direct or through its paired desktop, to its bot rows’ own-chat read', () => {
    for (const scope of [
      { kind: 'mobile' as const },
      { kind: 'mobile' as const, delegated: true }
    ]) {
      expect(denyRpcMethodForCaller(scope, 'bots.chats.own', 'workspace')).toBeNull()
    }
  })

  it.each([
    'bots.delete',
    'bots.avatar.upload',
    'bots.memory.edit',
    'bots.share.publish',
    'bots.tools.add',
    'bots.composio.setKey',
    'bots.slack.setUpApp',
    'bots.connect.start',
    'bots.lookAround.set',
    'google.bot.set',
    'google.status',
    'webhooks.reveal'
  ])("lets the owner's phone call %s on the bot's host", (method) => {
    expect(MOBILE_RPC_METHOD_ROUTES.get(method)).toBe('execution-host')
    expect(
      denyRpcMethodForCaller({ kind: 'mobile', delegated: true }, method, 'workspace')
    ).toBeNull()
  })
})

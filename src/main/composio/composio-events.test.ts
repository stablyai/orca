import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../shared/automations/automation-definition'
import type { ComposioApi } from './composio-api'
import { ComposioEvents } from './composio-events'
import { ComposioIngressStore, routeComposioCall } from './composio-events-ingress'

const BASE = 'https://hooks.orca.dev/hooks'

const P = 'project-1'
const signed = (id: string) => ({ automationId: id, hookId: id, signed: true })

function automation(id: string, botId: string, where: { path: string; values: string[] }[]) {
  const rule = {
    id: `wh:${id}`,
    source: 'webhook',
    event: 'call',
    rev: 1,
    where: where.map((w) => ({ ...w, op: '=' }))
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fields events read.
  return { id, enabled: true, createdAt: 0, bot: { botId }, on: [rule] } as unknown as Automation
}
const composioRule = (botId: string, slug: string) =>
  automation(`a-${botId}`, botId, [
    { path: 'body.metadata.trigger_slug', values: [slug] },
    { path: 'body.metadata.user_id', values: [`orca-bot-${botId}`] }
  ])

function eventsWith(
  subscriptions: { id: string; url: string; secret: string | null }[],
  options: {
    automations?: Automation[]
    triggers?: Record<string, { id: string; trigger: string }[]>
  } = {}
) {
  const automations = [...(options.automations ?? [])]
  const api = {
    webhookSubscriptions: vi.fn(async () => subscriptions),
    sendEventsTo: vi.fn(async (url: string, replacing?: string) => ({
      id: replacing ?? 'ws_new',
      url,
      secret: 'raw-secret'
    })),
    rotateSecret: vi.fn(async () => 'rotated'),
    triggerOn: vi.fn(async () => false),
    turnOnTrigger: vi.fn(async () => undefined),
    triggers: vi.fn(async (user: string) => options.triggers?.[user] ?? []),
    deleteTrigger: vi.fn(async () => undefined),
    send: vi.fn(async () => ({}))
  }
  const host = {
    botOf: (hookId: string) => (hookId.startsWith('h-') ? hookId.slice(2) : null),
    base: async (hookId: string) => `${BASE}/${hookId}`,
    url: async (hookId: string) => `${BASE}/${hookId}/key`,
    setSecret: vi.fn(async (_hookId: string, _secret: string) => undefined),
    createIngress: vi.fn(async (botId: string) => {
      automations.push(automation(`ingress-${botId}`, botId, []))
      return { automationId: `ingress-${botId}`, hookId: `ingress-${botId}` }
    }),
    automations: () => automations,
    deleteAutomation: vi.fn(async (id: string) => {
      automations.splice(
        automations.findIndex((entry) => entry.id === id),
        1
      )
    })
  }
  const store = new ComposioIngressStore(
    join(mkdtempSync(join(tmpdir(), 'composio-events-')), 'e.json')
  )
  // The project the saved key names; a test changes it as a key change would.
  const key = { project: P }
  const events = new ComposioEvents(
    {
      keyState: () => 'ok',
      project: () => key.project,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every method ComposioEvents calls.
      withKey: (call) => call(api as unknown as ComposioApi)
    },
    host,
    store
  )
  return { events, api, host, store, automations, key }
}

describe('Composio events, one address per project', () => {
  it('makes the project’s events hook on the first bot, and a second bot only turns its trigger on', async () => {
    const { events, api, host, store } = eventsWith([])
    await events.setUp('b1', 'h-b1', 'OUTLOOK_MESSAGE_TRIGGER', {}, false)
    expect(host.createIngress).toHaveBeenCalledWith('b1')
    expect(api.sendEventsTo).toHaveBeenCalledWith(`${BASE}/ingress-b1/key`, undefined)
    expect(host.setSecret).toHaveBeenCalledWith('ingress-b1', 'raw-secret')
    expect(store.read(P)).toEqual(signed('ingress-b1'))
    api.webhookSubscriptions.mockResolvedValue([
      { id: 'ws_new', url: `${BASE}/ingress-b1/key`, secret: null }
    ])
    await events.setUp('b2', 'h-b2', 'NOTION_PAGE_ADDED', {}, false)
    expect(api.sendEventsTo).toHaveBeenCalledTimes(1)
    expect(api.turnOnTrigger).toHaveBeenLastCalledWith('orca-bot-b2', 'NOTION_PAGE_ADDED', {})
    expect(await events.status('b2', 'h-b2', 'NOTION_PAGE_ADDED')).toEqual({
      target: 'ours',
      on: false,
      ingress: { hookId: 'ingress-b1', signed: true }
    })
  })

  it('asks before taking the project’s events from an address that isn’t Orca’s', async () => {
    const { events, api } = eventsWith([
      { id: 'ws_1', url: 'https://elsewhere.example/hook', secret: 'x' }
    ])
    expect((await events.status('b1', 'h-b1', 'T')).target).toBe('other')
    await expect(events.setUp('b1', 'h-b1', 'T', {}, false)).rejects.toThrow('another address')
    expect(api.turnOnTrigger).not.toHaveBeenCalled()
    await events.setUp('b1', 'h-b1', 'T', {}, true)
    expect(api.sendEventsTo).toHaveBeenCalledWith(`${BASE}/ingress-b1/key`, 'ws_1')
  })

  it('turns the trigger on before it moves the project’s address', async () => {
    const { events, api } = eventsWith([])
    api.turnOnTrigger.mockRejectedValue(new Error('Outlook is not connected'))
    await expect(events.setUp('b1', 'h-b1', 'T', {}, false)).rejects.toThrow('not connected')
    expect(api.sendEventsTo).not.toHaveBeenCalled()
  })

  it('upkeep deletes triggers no automation listens for, and moves the hook when its bot went', async () => {
    const { events, api, host, store } = eventsWith(
      [{ id: 'ws_1', url: `${BASE}/ingress-gone/key`, secret: null }],
      {
        automations: [composioRule('b2', 'NOTION_PAGE_ADDED')],
        triggers: {
          'orca-bot-b2': [
            { id: 'ti_keep', trigger: 'NOTION_PAGE_ADDED' },
            { id: 'ti_drop', trigger: 'OUTLOOK_MESSAGE_TRIGGER' }
          ]
        }
      }
    )
    store.write(P, signed('ingress-gone'))
    await events.reconcile(['b2'])
    expect(api.deleteTrigger.mock.calls).toEqual([['ti_drop']])
    expect(host.createIngress).toHaveBeenCalledWith('b2')
    expect(api.sendEventsTo).toHaveBeenCalledWith(`${BASE}/ingress-b2/key`, 'ws_1')
  })

  it('upkeep stops the project’s events and removes the hook once no bot listens', async () => {
    const { events, api, host, store } = eventsWith([
      { id: 'ws_1', url: `${BASE}/ingress-b1/key`, secret: null }
    ])
    await host.createIngress('b1')
    store.write(P, signed('ingress-b1'))
    await events.reconcile(['b1'])
    expect(api.send).toHaveBeenCalledWith('/webhook_subscriptions/ws_1', expect.anything(), {
      method: 'DELETE'
    })
    expect(host.deleteAutomation).toHaveBeenCalledWith('ingress-b1')
    expect(store.read(P)).toBeNull()
  })

  it('upkeep never makes the first hook: only the owner’s Set it up does', async () => {
    const { events, api, host } = eventsWith([], {
      automations: [composioRule('b1', 'T')]
    })
    await events.reconcile(['b1'])
    expect(host.createIngress).not.toHaveBeenCalled()
    expect(api.sendEventsTo).not.toHaveBeenCalled()
  })

  it('a setup whose secret failed to save finishes on the next try, and reads unset until then', async () => {
    const { events, api, host, store } = eventsWith([])
    host.setSecret.mockRejectedValueOnce(new Error('cloud down'))
    await expect(events.setUp('b1', 'h-b1', 'T', {}, false)).rejects.toThrow('cloud down')
    api.webhookSubscriptions.mockResolvedValue([
      { id: 'ws_new', url: `${BASE}/ingress-b1/key`, secret: null }
    ])
    expect((await events.status('b1', 'h-b1', 'T')).target).toBe('none')
    await events.setUp('b1', 'h-b1', 'T', {}, false)
    expect(api.rotateSecret).toHaveBeenCalledWith('ws_new')
    expect(host.setSecret).toHaveBeenLastCalledWith('ingress-b1', 'rotated')
    expect(store.read(P)?.signed).toBe(true)
    expect((await events.status('b1', 'h-b1', 'T')).target).toBe('ours')
  })

  it('upkeep reads listeners after Composio answers, so one made meanwhile keeps its trigger', async () => {
    const { events, api, automations } = eventsWith([], {
      triggers: { 'orca-bot-b1': [{ id: 'ti_new', trigger: 'T' }] }
    })
    api.triggers.mockImplementationOnce(async () => {
      automations.push(composioRule('b1', 'T'))
      return [{ id: 'ti_new', trigger: 'T' }]
    })
    await events.reconcile(['b1'])
    expect(api.deleteTrigger).not.toHaveBeenCalled()
  })

  it('runs two setups one after the other, so the project points at the one saved hook', async () => {
    const { events, api, host, store } = eventsWith([])
    let pointed: string | undefined
    api.sendEventsTo.mockImplementation(async (url: string) => {
      pointed = url
      api.webhookSubscriptions.mockResolvedValue([{ id: 'ws_new', url, secret: null }])
      return { id: 'ws_new', url, secret: 'raw-secret' }
    })
    await Promise.all([
      events.setUp('b1', 'h-b1', 'T', {}, false),
      events.setUp('b1', 'h-b1', 'U', {}, false)
    ])
    expect(host.createIngress).toHaveBeenCalledTimes(1)
    expect(pointed).toBe(`${BASE}/${store.read(P)?.hookId}/key`)
  })

  it('leaves a project whose events another address took since, and says they go elsewhere', async () => {
    const { events, api, host, store } = eventsWith(
      [{ id: 'ws_1', url: 'https://elsewhere.example/hook', secret: null }],
      { automations: [composioRule('b1', 'T')] }
    )
    store.write(P, signed('ingress-gone'))
    expect(events.eventsPlace()).toBeNull()
    await events.reconcile(['b1'])
    expect(host.createIngress).not.toHaveBeenCalled()
    expect(api.sendEventsTo).not.toHaveBeenCalled()
    expect(events.eventsPlace()).toEqual({ project: P, here: false, elsewhere: true })
  })
})

describe('doing it in Composio by hand', () => {
  it('gives the project’s events hook, made as Set it up makes it, and the status remembers the choice', async () => {
    const { events, api, host } = eventsWith([
      { id: 'ws_1', url: 'https://elsewhere.example/hook', secret: 'x' }
    ])
    expect(await events.byHand('b1', 'h-b1')).toBe('ingress-b1')
    expect(host.createIngress).toHaveBeenCalledWith('b1')
    expect(api.sendEventsTo).not.toHaveBeenCalled()
    expect(await events.status('b1', 'h-b1', 'T')).toEqual({
      target: 'other',
      on: false,
      ingress: { hookId: 'ingress-b1', signed: false }
    })
    expect(await events.byHand('b2', 'h-b2')).toBe('ingress-b1')
    expect(host.createIngress).toHaveBeenCalledTimes(1)
  })

  it('Done refuses until Composio sends the project’s events to Orca', async () => {
    const { events, api } = eventsWith([])
    await events.byHand('b1', 'h-b1')
    await expect(events.finishByHand('b1', 'h-b1', 'T', {}, 'ingress-b1')).rejects.toThrow(
      'Paste the URL'
    )
    expect(api.turnOnTrigger).not.toHaveBeenCalled()
  })

  // Composio's secret and the one on Orca's hook, as each side last took it.
  function secrets(
    api: ReturnType<typeof eventsWith>['api'],
    host: ReturnType<typeof eventsWith>['host']
  ) {
    const held: { composio: string; hook: string | null } = { composio: 'S', hook: null }
    let rotations = 0
    api.rotateSecret.mockImplementation(async () => (held.composio = `rotated-${(rotations += 1)}`))
    host.setSecret.mockImplementation(async (_hookId: string, secret: string) => {
      held.hook = secret
    })
    return held
  }

  it('Done saves Composio’s current secret even after upkeep rotated it and the owner pasted the old one', async () => {
    const { events, api, host, store } = eventsWith([], {
      automations: [composioRule('b1', 'T')]
    })
    const held = secrets(api, host)
    await events.byHand('b1', 'h-b1')
    api.webhookSubscriptions.mockResolvedValue([
      { id: 'ws_1', url: `${BASE}/ingress-b1/key`, secret: null }
    ])
    await events.reconcile(['b1'])
    expect(store.read(P)?.signed).toBe(true)
    // The owner pastes the secret they copied before upkeep rotated it, outside the lane.
    held.hook = 'S'
    await events.finishByHand('b1', 'h-b1', 'T', {}, 'ingress-b1')
    expect(held.hook).toBe(held.composio)
  })

  it('Done never takes a secret left on the hook from an earlier subscription as the current one', async () => {
    const { events, api, host, store } = eventsWith([
      { id: 'ws_1', url: `${BASE}/ingress-b1/key`, secret: null }
    ])
    const held = secrets(api, host)
    // An earlier subscription's secret is still on the hook; the new one never reached it.
    await host.createIngress('b1')
    store.write(P, { ...signed('ingress-b1'), signed: false })
    held.hook = 'old'
    await events.finishByHand('b1', 'h-b1', 'T', {}, 'ingress-b1')
    expect(held.hook).toBe(held.composio)
    expect(store.read(P)?.signed).toBe(true)
  })

  it('Done refuses steps shown for another project’s hook after a key change', async () => {
    const { events, api, host, key } = eventsWith([])
    const shown = await events.byHand('b1', 'h-b1')
    key.project = 'project-2'
    host.createIngress.mockImplementationOnce(async () => ({
      automationId: 'ingress-b1',
      hookId: 'ingress-p2'
    }))
    expect(await events.byHand('b1', 'h-b1')).toBe('ingress-p2')
    api.webhookSubscriptions.mockResolvedValue([
      { id: 'ws_2', url: `${BASE}/ingress-p2/key`, secret: null }
    ])
    await expect(events.finishByHand('b1', 'h-b1', 'T', {}, shown)).rejects.toThrow('key changed')
    expect(api.turnOnTrigger).not.toHaveBeenCalled()
  })
})

describe('removing the key with events', () => {
  it('turns every bot’s triggers off and stops the project’s events to Orca', async () => {
    const { events, api, host, store } = eventsWith(
      [{ id: 'ws_1', url: `${BASE}/ingress-b1/key`, secret: null }],
      { triggers: { 'orca-bot-b1': [{ id: 'ti_1', trigger: 'T' }] } }
    )
    await host.createIngress('b1')
    store.write(P, signed('ingress-b1'))
    await events.turnOff(['b1'])
    expect(api.deleteTrigger).toHaveBeenCalledWith('ti_1')
    expect(api.send).toHaveBeenCalledWith('/webhook_subscriptions/ws_1', expect.anything(), {
      method: 'DELETE'
    })
    expect(host.deleteAutomation).toHaveBeenCalledWith('ingress-b1')
    expect(store.read(P)).toBeNull()
  })
})

describe('routing a call to the project’s events hook', () => {
  const ingress = { automationId: 'ingress', hookId: 'ingress' }
  const automations = [
    composioRule('b1', 'OUTLOOK_MESSAGE_TRIGGER'),
    composioRule('b2', 'OUTLOOK_MESSAGE_TRIGGER')
  ]
  const call = (body: unknown) => ({ headers: {}, body })

  it('hands each event to the automation of the bot it names', () => {
    const event = {
      type: 'composio.trigger.message',
      metadata: { user_id: 'orca-bot-b2', trigger_slug: 'OUTLOOK_MESSAGE_TRIGGER' }
    }
    expect(routeComposioCall(automations, ingress, call(event))).toEqual({
      kind: 'automation',
      automationId: 'a-b2'
    })
    const other = { metadata: { user_id: 'orca-bot-b3', trigger_slug: 'OUTLOOK_MESSAGE_TRIGGER' } }
    expect(routeComposioCall(automations, ingress, call(other))).toEqual({ kind: 'none' })
  })

  it('picks the bot’s automation naming the trigger over a broader one, whatever the order', () => {
    const broad = {
      ...automation('broad', 'b1', [{ path: 'body.metadata.user_id', values: ['orca-bot-b1'] }])
    }
    const event = { metadata: { user_id: 'orca-bot-b1', trigger_slug: 'OUTLOOK_MESSAGE_TRIGGER' } }
    expect(routeComposioCall([broad, ...automations], ingress, call(event))).toEqual({
      kind: 'automation',
      automationId: 'a-b1'
    })
  })

  it('reads an expired sign-in as one, for the Reconnect card', () => {
    const expired = {
      type: 'composio.connected_account.expired',
      data: { id: 'ca_1', toolkit: { slug: 'gmail' } }
    }
    expect(routeComposioCall(automations, ingress, call(expired))).toEqual({
      kind: 'expired',
      accountId: 'ca_1',
      app: 'gmail'
    })
  })
})

describe('the key changing under the project’s events', () => {
  it('keeps a regenerated key’s project on its hook: still ours, remade when its bot goes, and stopped', async () => {
    const { events, api, host, store, key, automations } = eventsWith(
      [{ id: 'ws_1', url: `${BASE}/ingress-b1/key`, secret: null }],
      { automations: [composioRule('b2', 'T')] }
    )
    await host.createIngress('b1')
    store.write(P, signed('ingress-b1'))
    key.project = 'project-1-regenerated'
    expect((await events.status('b2', 'h-b2', 'T')).target).toBe('ours')
    // The hook's bot is deleted, and its automation with it.
    automations.splice(
      automations.findIndex((entry) => entry.id === 'ingress-b1'),
      1
    )
    await events.reconcile(['b2'])
    expect(host.createIngress).toHaveBeenLastCalledWith('b2')
    expect(api.sendEventsTo).toHaveBeenCalledWith(`${BASE}/ingress-b2/key`, 'ws_1')
    api.webhookSubscriptions.mockResolvedValue([
      { id: 'ws_1', url: `${BASE}/ingress-b2/key`, secret: null }
    ])
    await events.turnOff(['b2'])
    expect(api.send).toHaveBeenCalledWith('/webhook_subscriptions/ws_1', expect.anything(), {
      method: 'DELETE'
    })
  })

  it('leaves another project’s hook where it is after a switch', async () => {
    const { events, store, key } = eventsWith([
      { id: 'ws_b', url: 'https://elsewhere.example/hook', secret: null }
    ])
    store.write(P, signed('ingress-b1'))
    key.project = 'project-2'
    expect((await events.status('b1', 'h-b1', 'T')).target).toBe('other')
    expect(store.read(P)).toEqual(signed('ingress-b1'))
    expect(store.read('project-2')).toBeNull()
  })

  it('a key change waits for a setup under way, so its hook stays its own project’s', async () => {
    const { events, api, host, store, key } = eventsWith([])
    let finishTrigger = () => {}
    api.turnOnTrigger.mockImplementationOnce(
      () => new Promise<undefined>((resolve) => (finishTrigger = () => resolve(undefined)))
    )
    const setUp = events.setUp('b1', 'h-b1', 'T', {}, false)
    await vi.waitFor(() => expect(api.turnOnTrigger).toHaveBeenCalled())
    const keyChange = events.exclusive(async () => {
      key.project = 'project-2'
    })
    finishTrigger()
    await setUp
    await keyChange
    expect(store.read(P)).toEqual(signed('ingress-b1'))
    expect(store.read('project-2')).toBeNull()
    expect(host.setSecret).toHaveBeenCalledTimes(1)
  })

  it('abandons a setup whose key changed outside the lane, before saving or signing anything', async () => {
    const { events, api, host, store, key } = eventsWith([])
    api.turnOnTrigger.mockImplementationOnce(async () => {
      key.project = 'project-2'
      return undefined
    })
    await expect(events.setUp('b1', 'h-b1', 'T', {}, false)).rejects.toThrow('key changed')
    expect(store.read(P)).toBeNull()
    expect(store.read('project-2')).toBeNull()
    expect(host.setSecret).not.toHaveBeenCalled()
  })
})

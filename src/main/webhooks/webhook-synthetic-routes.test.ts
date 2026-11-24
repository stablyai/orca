import { expect, it } from 'vitest'
import { WEBHOOK_HOOK_ID_PATTERN } from '../../shared/connector-webhook-contract'
import { syntheticWebhookRoutes } from './webhook-synthetic-routes'

it('mints one live synthetic hook per operation and answers its card reads and key', async () => {
  const routes = syntheticWebhookRoutes()
  const body = { operationId: 'op-1', automationId: 'auto-1', botId: 'bot-1' }
  const first = await routes.mint(body)
  const again = await routes.mint(body)
  expect(first?.ok && again?.ok && first.value.hookId === again.value.hookId).toBe(true)
  if (!first?.ok) {
    throw new Error('mint failed')
  }
  const { hookId } = first.value
  expect(hookId).toMatch(WEBHOOK_HOOK_ID_PATTERN)
  expect(first.value).toMatchObject({ state: 'live', automationId: 'auto-1', botId: 'bot-1' })
  expect(await routes.get(hookId)).toMatchObject({ ok: true, value: { hookId } })
  expect(await routes.list('bot-1')).toMatchObject({ ok: true, value: { hooks: [{ hookId }] } })
  expect(await routes.reveal(hookId, {})).toMatchObject({
    ok: true,
    value: { key: expect.any(String) }
  })
  expect(await routes.get('wh_AAAAAAAAAAAAAAAA')).toMatchObject({ ok: false, status: 404 })
})

it('never delivers a call: no sample and no run start', async () => {
  const routes = syntheticWebhookRoutes()
  const minted = await routes.mint({ operationId: 'op', automationId: 'a', botId: 'b' })
  const hookId = minted?.ok ? minted.value.hookId : ''
  expect(await routes.sample(hookId, 'op-sample')).toMatchObject({ ok: false })
  expect(await routes.start('call_AAAAAAAAAAAAAAAAAAAA', 'run-1')).toMatchObject({ ok: false })
})

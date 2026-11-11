import { expect, it } from 'vitest'
import { attach, rig } from './browser-page-creation.test-fixture'
import { runWithActiveRpcCaller } from '../../rpc/rpc-active-caller'
import { LOCAL_CLI_RPC_CALLER, DESKTOP_RPC_CALLER } from '../../rpc/rpc-caller-identity'
import {
  reserveBrowserPageDiscard,
  closeBrowserMemoryPage
} from '../../../browser/guest-lifecycle/browser-page-memory'

it('does not resurrect closed creation holds at N and 10N after late navigation completion', async () => {
  for (const count of [2, 20]) {
    const deadIds: string[] = []
    for (let index = 0; index < count; index++) {
      const pageId = `closed-create-${count}-${index}`
      const test = rig()
      const pending = test.create(pageId)
      // Reply is emitted outside the initiating RPC context, as real ipcMain does.
      test.reply()
      const guest = await attach(pageId)
      expect(reserveBrowserPageDiscard(pageId, guest)).toBe(false)
      await test.started
      closeBrowserMemoryPage(pageId)
      test.finishNavigation()
      await pending
      deadIds.push(pageId)
    }
    for (const pageId of deadIds) {
      const later = await attach(pageId)
      expect(reserveBrowserPageDiscard(pageId, later)).toBe(true)
    }
  }
})

it('retires pending creator ownership but leaves an adopted rebound page held', async () => {
  const pendingRig = rig()
  const pending = pendingRig.create('pending-owner', 'about:blank')
  pendingRig.reply()
  await pending
  pendingRig.destroy()
  expect(reserveBrowserPageDiscard('pending-owner', await attach('pending-owner'))).toBe(true)
  const reboundRig = rig()
  const rebound = reboundRig.create('rebound-owner', 'about:blank')
  reboundRig.reply()
  await rebound
  await attach('rebound-owner')
  const replacement = await attach('rebound-owner', 100)
  reboundRig.destroy()
  expect(reserveBrowserPageDiscard('rebound-owner', replacement)).toBe(false)
})

it('uses the captured caller at reply and creates no hold on a rejected reply or dead creator', async () => {
  const human = rig()
  const created = runWithActiveRpcCaller(DESKTOP_RPC_CALLER, () =>
    human.commands.browserTabCreate({
      page: 'human-create',
      url: 'about:blank',
      waitForRegistration: false
    })
  )
  runWithActiveRpcCaller(LOCAL_CLI_RPC_CALLER, () => human.reply())
  await created
  expect(reserveBrowserPageDiscard('human-create', await attach('human-create'))).toBe(true)
  const rejected = rig()
  const failed = rejected.create('rejected-create')
  rejected.reply('Refused')
  await expect(failed).rejects.toThrow('Refused')
  expect(reserveBrowserPageDiscard('rejected-create', await attach('rejected-create'))).toBe(true)
  const dead = rig()
  const late = dead.create('dead-creator', 'about:blank')
  dead.destroy()
  dead.reply()
  await late
  expect(reserveBrowserPageDiscard('dead-creator', await attach('dead-creator'))).toBe(true)
})

it('does not give an offscreen creation a desktop hold when a window appears before completion', async () => {
  const test = rig()
  test.unavailable()
  let finish: () => void = () => {}
  test.offscreen.createTab.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    return { browserPageId: 'offscreen-create' }
  })
  const pending = test.create('offscreen-create', 'about:blank')
  test.available()
  finish()
  await pending
  expect(reserveBrowserPageDiscard('offscreen-create', await attach('offscreen-create'))).toBe(true)
})

it('keeps an accepted pending creation held when a real snapshot fails before registration', async () => {
  const test = rig()
  const created = test.create('pending-snapshot', 'about:blank')
  test.reply()
  await created
  test.registration.mockRejectedValueOnce(new Error('Browser page registration failed'))
  await expect(test.commands.browserSnapshot({ page: 'pending-snapshot' })).rejects.toThrow(
    'Browser page registration failed'
  )
  expect(reserveBrowserPageDiscard('pending-snapshot', await attach('pending-snapshot'))).toBe(
    false
  )
})

it('does not let an old failed operation remove a replacement pending creation hold', async () => {
  const test = rig()
  let failRegistration: (error: Error) => void = () => {}
  let beginRegistration: () => void = () => {}
  const began = new Promise<void>((resolve) => {
    beginRegistration = resolve
  })
  test.registration.mockImplementationOnce(async () => {
    beginRegistration()
    await new Promise<void>((_, reject) => {
      failRegistration = reject
    })
  })
  const old = test.commands.browserSnapshot({ page: 'replaced-pending' })
  const failed = expect(old).rejects.toThrow('Old registration failed')
  await began
  closeBrowserMemoryPage('replaced-pending')
  const replacement = test.create('replaced-pending', 'about:blank')
  test.reply()
  await replacement
  failRegistration(new Error('Old registration failed'))
  await failed
  expect(reserveBrowserPageDiscard('replaced-pending', await attach('replaced-pending'))).toBe(
    false
  )
})

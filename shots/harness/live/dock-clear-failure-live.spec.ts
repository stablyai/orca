// Ad hoc, not committed: one live pass of /clear, a provider failure, Clear and restore in a hidden,
// isolated Orca build driven by the stub Claude. No real agent, account or user data.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from '@stablyai/playwright-test'
import { test, openStubChat } from '../session-fixtures/structured-claude-stub'

const out = process.env.DOCK_LIVE_OUT ?? '/tmp/dock-live'
test.use({ minimumSeededWorktreeCount: 1, orcaAppExtraEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

test('a failure after /clear shows in the chat dock, clears and restores', async ({
  orcaPage: page,
  electronApp,
  claudeStub
}) => {
  test.setTimeout(180_000)
  mkdirSync(out, { recursive: true })
  const log: Record<string, unknown> = {}
  const windows = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), focused: w.isFocused() }))
  )
  log.windows = windows
  expect(windows.every((w) => !w.visible && !w.focused)).toBe(true)
  log.userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  log.appHome = await electronApp.evaluate(() => process.env.HOME)
  if (process.platform === 'darwin') {
    await page.evaluate(() => window.api.macosTccPrompts.dismiss())
  }
  const chat = await openStubChat(page, claudeStub.command)
  const tabSession = () =>
    page.evaluate(
      () =>
        Object.values(window.__store?.getState().unifiedTabsByWorktree ?? {})
          .flat()
          .find((tab) => tab.contentType === 'agent-session')?.entityId
    )
  await chat.composer.fill('hello')
  await chat.send.click()
  await expect(chat.reply.first()).toBeVisible({ timeout: 30_000 })
  log.before = await tabSession()

  await chat.composer.fill('/clear')
  await page.keyboard.press('Escape')
  await chat.send.click()
  await expect(page.getByText('Context cleared')).toBeVisible({ timeout: 30_000 })
  log.tabAfterClear = await tabSession()

  await chat.composer.click()
  await chat.composer.fill('dock-fail')
  await chat.send.click()
  // This build's /clear keeps the Orca session and swaps the provider session under it.
  log.recordsAfterClear = execFileSync(
    'sqlite3',
    [
      '-readonly',
      join(String(log.userData), 'agent-session-domain.db'),
      "SELECT session_id, json_extract(record_json, '$.conversationCommand.replacementSessionId'), json_array_length(json_extract(record_json, '$.providerHandleChain')) FROM agent_session_records"
    ],
    { encoding: 'utf8' }
  ).trim()
  log.after = log.tabAfterClear
  const root = page.locator('[data-native-chat-root="true"]')
  const header = root.locator('[data-worker-dock-header] button').first()
  await expect(header).toContainText('failed', { timeout: 30_000 })
  log.header = await header.textContent()
  await page.screenshot({ path: join(out, 'live-1-failure-folded.png') })
  await header.click()
  const row = root.locator('[data-worker-dock-row]').first()
  await expect(row).toBeVisible()
  log.row = await row.textContent()
  log.lead = await row.getAttribute('data-worker-dock-lead')
  await page.screenshot({ path: join(out, 'live-2-failure-open.png') })

  // The same read the dock makes, through the root party and the live one.
  const read = (session: unknown) =>
    page.evaluate(
      (s) =>
        window.api.runtime.call({
          method: 'orchestration.workerDockRead',
          params: { party: `orca_session_id:${s}`, direction: 'around' }
        }),
      session
    )
  const viaLive = (await read(log.after)) as {
    ok: boolean
    result: { rows: { source: string; dispatchId: string; settlement: string }[] }
  }
  const viaRoot = (await read(log.before)) as typeof viaLive
  log.rowsViaLive = viaLive.result.rows.map((r) => ({ source: r.source, id: r.dispatchId }))
  log.rowsViaRoot = viaRoot.result.rows.map((r) => ({ source: r.source, id: r.dispatchId }))
  expect(viaLive.result.rows[0]?.source).toBe(log.before)

  const failure = viaLive.result.rows[0]
  await row.locator('[data-worker-dock-action]').click()
  await expect(root.locator('[data-worker-dock-header]')).toHaveCount(0, { timeout: 15_000 })
  log.afterClear = await root.locator('[data-native-chat-worker-dock]').count()
  await page.screenshot({ path: join(out, 'live-3-cleared.png') })

  // Provider failures have no restore button; this is the RPC the worker result's restore uses.
  log.restore = await page.evaluate(
    (f) =>
      window.api.runtime.call({
        method: 'orchestration.workerDockAcknowledge',
        params: {
          party: `orca_session_id:${f.live}`,
          acknowledged: false,
          settlements: [{ dispatchId: f.dispatchId, settlement: f.settlement }]
        }
      }),
    { live: log.after, dispatchId: failure.dispatchId, settlement: failure.settlement }
  )
  await expect(root.locator('[data-worker-dock-header] button').first()).toContainText('failed', {
    timeout: 15_000
  })
  await page.screenshot({ path: join(out, 'live-4-restored.png') })
  writeFileSync(join(out, 'live-report.json'), `${JSON.stringify(log, null, 2)}\n`)
})

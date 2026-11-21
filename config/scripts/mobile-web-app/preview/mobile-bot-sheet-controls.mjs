import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'

export async function createFirstMobileBot(page, bot, home) {
  const header = page.getByRole('button', { name: /^Bots, 0 bots,/ })
  expect(await header.getAttribute('aria-disabled')).toBe('true')
  await header.click({ force: true })
  expect(await header.getAttribute('aria-expanded')).toBe('true')
  expect(
    await page.evaluate(() =>
      globalThis.__orcaRenderCheckRequests.some((request) => request.method === 'ui.set')
    )
  ).toBe(false)
  await page.getByRole('button', { name: 'New bot', exact: true }).click()
  await page.getByPlaceholder('Name your bot').fill(bot.name)
  await page.evaluate(
    ({ bot, home }) =>
      globalThis.__orcaRenderCheckSetReplies({
        'bots.create': { bot },
        'bots.list': { botsEnabled: true, hideBotCreatedWorkspaces: true, bots: [bot] },
        'worktree.ps': { worktrees: [home] }
      }),
    { bot, home }
  )
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect.poll(() => page.getByText(bot.name, { exact: true }).count()).toBeGreaterThan(0)
  expect(
    await page.getByRole('button', { name: /^Bots, 1 bots,/ }).getAttribute('aria-expanded')
  ).toBe('true')
  await captureBotView(page, 'mobile-first-bot-created')
}

export async function openMobileBotSheet(page, name) {
  await page.getByRole('button', { name: 'More session actions', exact: true }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
  await page.getByRole('menu').waitFor({ state: 'hidden' })
  await page.getByTestId('bot-sheet-tab-activity').waitFor()
}

export async function captureBotView(page, name) {
  const directory = process.env.ORCA_BOTS_EVIDENCE_DIR
  if (!directory) {
    return
  }
  await mkdir(directory, { recursive: true })
  await page.waitForFunction(() => {
    const sheet = document.querySelector('[data-testid="bottom-drawer-sheet"]')
    if (!sheet) {
      return true
    }
    const style = getComputedStyle(sheet)
    const transform = new DOMMatrixReadOnly(style.transform)
    return Math.abs(transform.m42) < 0.1 && Number(style.opacity) === 1
  })
  await page.screenshot({ path: join(directory, `${name}.png`) })
}

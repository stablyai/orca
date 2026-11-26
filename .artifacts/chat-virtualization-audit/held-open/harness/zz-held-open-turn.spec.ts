// DISPOSABLE RUN HARNESS (not for merge): an older page that brings the prompt of the turn whose
// opened run the reader is looking at. Both lanes, two cases each, plus a never-opened control:
//   prompt:          the first window starts at the run's head, so the page brings only the prompt;
//   prompt+earlier:  the first window starts inside the run, so the page also brings its earlier
//                    commands and the run's head moves earlier;
//   control:         as prompt+earlier, but the reader never opened the run.
// Each case writes <lane>-<case>.json to AUDIT_OUT (default: the OS temp dir) and asserts.
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Locator, Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { createOrcaSessionId } from '../../../../src/shared/agent-session/identity/orca-session-address'
import { structuredAgentSessionCreateParams } from '../../../../src/shared/agent-session/lifecycle/operations/structured-agent-session-create'
import {
  ensureTerminalVisible,
  waitForActiveWorktree,
  waitForSessionReady
} from '../../desktop/renderer-probes/store'
import { waitForActivePanePtyId, waitForPaneIdentitySnapshot } from '../../terminal/input/terminal'
import { waitForActivePaneHookDescriptor } from '../../terminal/input/terminal-active-pane'
import { waitForActiveTerminalManager } from '../../terminal/layout/terminal-pane-operations'
import { waitForPtyShellEcho } from '../../terminal/lifecycle/terminal-pty-readiness'
import {
  enableNativeChatSetting,
  seedClaudeProviderSession,
  toggleTerminalTabToChatView
} from '../session-fixtures/native-chat-transcript-fixture'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { openStubChat, SUPPORTED, test as structuredTest } from './zz-held-open-structured-stub'

type Case = 'prompt' | 'prompt+earlier' | 'control'
const CASES: readonly Case[] = ['prompt', 'prompt+earlier', 'control']
const OUT = process.env.AUDIT_OUT ?? os.tmpdir()

/** Waits until the scroller holds still for three frames: no real-time waits. */
async function settle(scroll: Locator): Promise<void> {
  await expect
    .poll(
      () =>
        scroll.evaluate(async (root) => {
          const read = () => `${root.scrollTop}:${root.scrollHeight}`
          const first = read()
          for (let frame = 0; frame < 3; frame += 1) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          }
          return read() === first
        }),
      { timeout: 30_000 }
    )
    .toBe(true)
}

async function wheelToTop(page: Page, scroll: Locator): Promise<void> {
  await scroll.hover()
  await expect
    .poll(
      async () => {
        await page.mouse.wheel(0, -4_000)
        await settle(scroll)
        return scroll.evaluate((root) => root.scrollTop)
      },
      { timeout: 60_000 }
    )
    .toBe(0)
}

/** The run right after the turn's prompt (or the first run when the prompt is not loaded), and
 *  the turn's status row. Commands are named `cat <prefix>-N.log`. */
function readRun(scroll: Locator, prompt: string, prefix: string, output: string) {
  return scroll.evaluate(
    (root, { prompt, prefix, output }) => {
      const promptNode = Array.from(root.querySelectorAll('p')).find(
        (node) => node.textContent?.trim() === prompt
      )
      const after = (node: Element) =>
        !promptNode ||
        Boolean(promptNode.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
      const header = Array.from(root.querySelectorAll('[data-native-chat-tool-run-state]')).find(
        after
      )
      const row = header?.closest('[data-index]')
      const members = row?.querySelector('[data-native-chat-tool-run-members]')
      const pattern = new RegExp(`cat ${prefix}-\\d+\\.log`, 'g')
      const commands = [...new Set(members?.textContent?.match(pattern) ?? [])].sort()
      const status = Array.from(root.querySelectorAll('[data-native-chat-turn-status]')).find(after)
      return {
        promptLoaded: promptNode !== undefined,
        runExpanded: header?.getAttribute('aria-expanded') ?? null,
        commands,
        outputShown: members?.textContent?.includes(output) === true,
        turnExpanded: status?.getAttribute('aria-expanded') ?? null,
        turnLabel: status?.getAttribute('aria-label') ?? null
      }
    },
    { prompt, prefix, output }
  )
}

async function loadOlderPage(page: Page, scroll: Locator): Promise<void> {
  const height = await scroll.evaluate((root) => root.scrollHeight)
  const load = page.getByRole('button', { name: 'Load earlier messages' })
  await expect(load).toBeAttached({ timeout: 30_000 })
  // Clicked without scrolling, so the reader's place is where they left it.
  await load.evaluate((button) => {
    if (button instanceof HTMLButtonElement) {
      button.click()
    }
  })
  await expect
    .poll(() => scroll.evaluate((root) => root.scrollHeight), { timeout: 60_000 })
    .not.toBe(height)
  await settle(scroll)
}

/** Where a seeded marker sits in the transcript, so a reveal knows which way to scroll. */
type Place = (text: string) => number | null

/** Scrolls, as a reader would, until the turn's prompt is drawn. Right after the page lands the
 *  prompt can be on either side of the drawn window; the seeded markers drawn say which. */
async function revealPrompt(page: Page, scroll: Locator, prompt: string, place: Place) {
  const target = place(prompt)
  if (target === null) {
    throw new Error(`No place for the prompt ${prompt}`)
  }
  await scroll.hover()
  await expect
    .poll(
      async () => {
        const texts = await scroll.evaluate((root) =>
          Array.from(root.querySelectorAll('p')).map((node) => node.textContent?.trim() ?? '')
        )
        if (texts.includes(prompt)) {
          return true
        }
        const places = texts.map(place).filter((at): at is number => at !== null)
        const promptAbove = places.length === 0 || Math.min(...places) > target
        await page.mouse.wheel(0, promptAbove ? -300 : 300)
        await settle(scroll)
        return false
      },
      { timeout: 60_000 }
    )
    .toBe(true)
}

async function statusRow(scroll: Locator, prompt: string): Promise<Locator> {
  const index = await scroll.evaluate((root, prompt) => {
    const promptNode = Array.from(root.querySelectorAll('p')).find(
      (node) => node.textContent?.trim() === prompt
    )
    return Array.from(root.querySelectorAll('[data-native-chat-turn-status]')).findIndex(
      (node) =>
        promptNode !== undefined &&
        Boolean(promptNode.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
    )
  }, prompt)
  expect(index, 'the turn has a status row after its prompt').toBeGreaterThanOrEqual(0)
  return scroll.locator('[data-native-chat-turn-status]').nth(index)
}

/** The journey every case shares, from a transcript whose first window is already open. */
async function pageOverRun(
  page: Page,
  scroll: Locator,
  args: {
    lane: string
    kase: Case
    prompt: string
    prefix: string
    commands: number
    /** The newest command's output, which the reader opens. */
    output: string
    place: Place
  }
): Promise<void> {
  const { lane, kase, prompt, prefix, output } = args
  const read = () => readRun(scroll, prompt, prefix, output)
  await wheelToTop(page, scroll)
  const opened = kase !== 'control'
  if (opened) {
    await scroll.locator('[data-native-chat-tool-run-state][aria-expanded="false"]').first().click()
    await settle(scroll)
  }
  const before = await read()
  expect(before.promptLoaded, 'the first window does not hold the prompt').toBe(false)
  // Open the newest command's output too, so what the reader opened inside the run is under test.
  if (opened) {
    await scroll
      .locator('[data-native-chat-tool-run-members]')
      .getByRole('button', { name: new RegExp(`cat ${prefix}-${args.commands - 1}\\.log`) })
      .first()
      .click()
    await settle(scroll)
    expect((await read()).outputShown, 'the opened output shows').toBe(true)
  }
  // Read a little into the run, as a reader would.
  await page.mouse.wheel(0, 60)
  await settle(scroll)
  await loadOlderPage(page, scroll)
  await revealPrompt(page, scroll, prompt, args.place)
  const after = await read()

  // Fold-control parity: the status row folds and reopens the held turn like a clicked one.
  const row = await statusRow(scroll, prompt)
  const parity: Record<string, unknown> = {}
  if (opened) {
    parity.heldExpanded = await row.getAttribute('aria-expanded')
    await row.click()
    await settle(scroll)
    parity.afterFold = await read()
    await row.click()
    await settle(scroll)
    parity.afterReopen = await read()
  }
  writeFileSync(
    path.join(OUT, `${lane}-${kase}.json`),
    JSON.stringify({ lane, kase, before, after, parity }, null, 2)
  )

  expect(after.promptLoaded, 'the older page brought the prompt').toBe(true)
  if (kase === 'prompt') {
    expect(before.commands.length, 'the first window starts at the run head').toBe(args.commands)
  } else {
    expect(before.commands.length, 'the first window starts inside the run').toBeLessThan(
      args.commands
    )
  }
  if (opened) {
    expect(after.turnExpanded, 'the turn stays unfolded').toBe('true')
    expect(after.runExpanded, 'the opened run stays open').toBe('true')
    expect(after.commands).toEqual(expect.arrayContaining(before.commands))
    expect(after.commands.length).toBe(args.commands)
    expect(after.outputShown, 'the output the reader opened stays open').toBe(true)
    expect(parity.heldExpanded).toBe('true')
    expect(parity.afterFold).toMatchObject({ turnExpanded: 'false', commands: [] })
    expect(parity.afterReopen).toMatchObject({ turnExpanded: 'true', runExpanded: 'true' })
  } else {
    // The run is not open (a folded turn does not draw its header at all), and expanding the
    // turn shows it still closed.
    expect(after.runExpanded, 'a run the reader never opened is not open').not.toBe('true')
    expect(after.commands).toEqual([])
    if (after.turnExpanded === 'false') {
      await row.click()
      await settle(scroll)
    }
    const expanded = await read()
    writeFileSync(
      path.join(OUT, `${lane}-${kase}-expanded.json`),
      JSON.stringify(expanded, null, 2)
    )
    expect(expanded.turnExpanded).toBe('true')
    expect(expanded.runExpanded, 'it stays closed once the turn is open').toBe('false')
    expect(expanded.commands).toEqual([])
  }
}

const PROMPT = 'The run prompt'

/** A Claude terminal chat over a seeded transcript: `olderCount` rows, the run's prompt, a run of
 *  `runCalls` commands (`cat c-N.log`), its answer and `newerCount - 1` more rows. Manual paging,
 *  so older pages land only when asked. */
async function openTerminalChat(
  page: Page,
  shape: { olderCount: number; runCalls: number; newerCount: number }
) {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page, 30_000)
  await waitForPaneIdentitySnapshot(page, 1)
  const ptyId = await waitForActivePanePtyId(page)
  await waitForPtyShellEcho(page, ptyId, 15_000)
  const descriptor = await waitForActivePaneHookDescriptor(page)
  const [tabId] = descriptor.paneKey.split(':')
  const sessionId = `e2e-held-open-${randomUUID()}`
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-held-open-'))
  const transcriptPath = path.join(dir, `${sessionId}.jsonl`)
  let at = 0
  const line = (type: 'user' | 'assistant', content: unknown[]) =>
    JSON.stringify({
      sessionId,
      uuid: `${sessionId}-${(at += 1)}`,
      timestamp: new Date(Date.now() - 10_000_000 + at * 1_000).toISOString(),
      type,
      message: { id: `m-${at}`, role: type, model: 'claude-opus-4', content }
    })
  const older = Array.from({ length: shape.olderCount }, (_, index) =>
    line(index % 2 ? 'assistant' : 'user', [{ type: 'text', text: `Older row ${index}` }])
  )
  const run = Array.from({ length: shape.runCalls }, (_, index) => [
    line('assistant', [
      { type: 'tool_use', id: `c-${index}`, name: 'Bash', input: { command: `cat c-${index}.log` } }
    ]),
    line('user', [{ type: 'tool_result', tool_use_id: `c-${index}`, content: `c ${index} ok` }])
  ]).flat()
  const newer = Array.from({ length: shape.newerCount }, (_, index) =>
    line(index % 2 ? 'user' : 'assistant', [{ type: 'text', text: `Newer row ${index}` }])
  )
  const prompt = line('user', [{ type: 'text', text: PROMPT }])
  writeFileSync(transcriptPath, `${[...older, prompt, ...run, ...newer].join('\n')}\n`)
  const cleanup = () => rmSync(dir, { recursive: true, force: true })
  try {
    await enableNativeChatSetting(page)
    await seedClaudeProviderSession(page, {
      paneKey: descriptor.paneKey,
      worktreeId: descriptor.worktreeId,
      sessionId,
      transcriptPath
    })
    await page.evaluate(() => {
      Object.defineProperty(window, 'IntersectionObserver', {
        value: undefined,
        configurable: true
      })
    })
    await toggleTerminalTabToChatView(page, { tabId, worktreeId: descriptor.worktreeId })
    await expect(page.locator('[data-native-chat-window]')).toBeVisible({ timeout: 30_000 })
  } catch (error) {
    cleanup()
    throw error
  }
  const place: Place = (text) => {
    const olderRow = /^Older row (\d+)$/.exec(text)
    const newerRow = /^Newer row (\d+)$/.exec(text)
    const liveRow = /^Live row (\d+)$/.exec(text)
    if (text === PROMPT) {
      return shape.olderCount
    }
    if (olderRow) {
      return Number(olderRow[1])
    }
    if (newerRow) {
      return 1_000_000 + Number(newerRow[1])
    }
    return liveRow ? 2_000_000 + Number(liveRow[1]) : null
  }
  return {
    scroll: page.locator('[data-native-chat-scroll]').filter({ visible: true }),
    place,
    append: (type: 'user' | 'assistant', content: unknown[]) =>
      appendFileSync(transcriptPath, `${line(type, content)}\n`),
    cleanup
  }
}

test.describe('An older page brings the prompt of an opened run', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await orcaPage.setViewportSize({ width: 1280, height: 900 })
  })

  for (const kase of CASES) {
    test(`terminal lane: ${kase}`, async ({ orcaPage }) => {
      test.setTimeout(240_000)
      // The first window is the newest 300 records: 284 newer ones start it at the run's head,
      // 296 start it two commands from the run's end.
      const chat = await openTerminalChat(orcaPage, {
        olderCount: 60,
        runCalls: 8,
        newerCount: kase === 'prompt' ? 284 : 296
      })
      try {
        await pageOverRun(orcaPage, chat.scroll, {
          lane: 'terminal',
          kase,
          prompt: PROMPT,
          prefix: 'c',
          commands: 8,
          output: 'c 7 ok',
          place: chat.place
        })
      } finally {
        chat.cleanup()
      }
    })
  }

  test('terminal lane: a run older pages grow over three or more pages', async ({ orcaPage }) => {
    test.setTimeout(600_000)
    // 450 calls (900 records) end 10 rows before the newest: the first window holds the run's
    // last 145 calls, and each 200-record page brings 100 more. Those pages are only the run's
    // calls, which the read folds into the run's first row, so they keep the row count.
    const chat = await openTerminalChat(orcaPage, { olderCount: 20, runCalls: 450, newerCount: 10 })
    try {
      const { scroll } = chat
      await wheelToTop(orcaPage, scroll)
      await scroll
        .locator('[data-native-chat-tool-run-state][aria-expanded="false"]')
        .first()
        .click()
      await settle(scroll)
      const pages: unknown[] = []
      for (let page = 0; page < 8; page += 1) {
        await wheelToTop(orcaPage, scroll)
        if ((await scroll.getByRole('button', { name: 'Load earlier messages' }).count()) === 0) {
          break
        }
        await loadOlderPage(orcaPage, scroll)
        await wheelToTop(orcaPage, scroll)
        const run = await scroll.evaluate((root) => {
          const header = root.querySelector('[data-native-chat-tool-run-state]')
          return { expanded: header?.getAttribute('aria-expanded') ?? null }
        })
        pages.push(run)
        expect(run.expanded, `the run stays open after page ${page + 1}`).toBe('true')
      }
      await revealPrompt(orcaPage, scroll, PROMPT, chat.place)
      const after = await readRun(scroll, PROMPT, 'c', 'c 449 ok')
      writeFileSync(
        path.join(OUT, 'terminal-pages.json'),
        JSON.stringify({ pages, after }, null, 2)
      )
      expect(pages.length, 'three or more pages').toBeGreaterThanOrEqual(3)
      expect(after).toMatchObject({ promptLoaded: true, turnExpanded: 'true', runExpanded: 'true' })
    } finally {
      chat.cleanup()
    }
  })

  test('terminal lane: a turn folded after its prompt landed stays folded over the next page', async ({
    orcaPage
  }) => {
    test.setTimeout(300_000)
    // The first page brings the run's prompt; 450 older rows leave more pages after it.
    const chat = await openTerminalChat(orcaPage, { olderCount: 450, runCalls: 8, newerCount: 296 })
    try {
      const { scroll } = chat
      await wheelToTop(orcaPage, scroll)
      await scroll
        .locator('[data-native-chat-tool-run-state][aria-expanded="false"]')
        .first()
        .click()
      await settle(scroll)
      await loadOlderPage(orcaPage, scroll)
      await revealPrompt(orcaPage, scroll, PROMPT, chat.place)
      const held = await readRun(scroll, PROMPT, 'c', 'c 7 ok')
      expect(held.turnExpanded, 'the turn stays open when its prompt lands').toBe('true')
      // The reader folds it, then pages on.
      await (await statusRow(scroll, PROMPT)).click()
      await settle(scroll)
      expect((await readRun(scroll, PROMPT, 'c', 'c 7 ok')).turnExpanded).toBe('false')
      await wheelToTop(orcaPage, scroll)
      await loadOlderPage(orcaPage, scroll)
      await revealPrompt(orcaPage, scroll, PROMPT, chat.place)
      const after = await readRun(scroll, PROMPT, 'c', 'c 7 ok')
      writeFileSync(
        path.join(OUT, 'terminal-fold-then-page.json'),
        JSON.stringify({ held, after }, null, 2)
      )
      expect(after.turnExpanded, 'the reader’s fold holds').toBe('false')
    } finally {
      chat.cleanup()
    }
  })

  test('terminal lane: live rows after a run kept its disclosures', async ({ orcaPage }) => {
    test.setTimeout(300_000)
    const chat = await openTerminalChat(orcaPage, { olderCount: 60, runCalls: 8, newerCount: 296 })
    try {
      const { scroll } = chat
      await wheelToTop(orcaPage, scroll)
      await scroll
        .locator('[data-native-chat-tool-run-state][aria-expanded="false"]')
        .first()
        .click()
      await settle(scroll)
      await loadOlderPage(orcaPage, scroll)
      await revealPrompt(orcaPage, scroll, PROMPT, chat.place)
      expect((await readRun(scroll, PROMPT, 'c', 'c 7 ok')).runExpanded).toBe('true')
      // The agent writes on: each live row lands while the moved run stays open.
      const frames: { row: number; ms: number; runExpanded: string | null }[] = []
      for (let row = 0; row < 20; row += 1) {
        const started = Date.now()
        chat.append('assistant', [{ type: 'text', text: `Live row ${row}` }])
        await expect(scroll.getByText(`Live row ${row}`, { exact: true })).toBeAttached({
          timeout: 30_000
        })
        await revealPrompt(orcaPage, scroll, PROMPT, chat.place)
        const run = await readRun(scroll, PROMPT, 'c', 'c 7 ok')
        frames.push({ row, ms: Date.now() - started, runExpanded: run.runExpanded })
      }
      writeFileSync(
        path.join(OUT, 'terminal-live-after-carry.json'),
        JSON.stringify(frames, null, 2)
      )
      expect(frames.every((frame) => frame.runExpanded === 'true')).toBe(true)
    } finally {
      chat.cleanup()
    }
  })
})

structuredTest.describe('An older page brings the prompt of an opened run (structured)', () => {
  structuredTest.beforeEach(async ({ orcaPage }) => {
    await orcaPage.setViewportSize({ width: 1280, height: 900 })
  })

  for (const kase of CASES) {
    structuredTest(`structured lane: ${kase}`, async ({ orcaPage, electronApp, claudeStub }) => {
      structuredTest.skip(!SUPPORTED)
      structuredTest.setTimeout(600_000)
      await openStubChat(orcaPage, claudeStub.command)
      const home = await electronApp.evaluate(({ app }) => app.getPath('home'))
      const active = await orcaPage.evaluate(() => {
        const state = window.__store?.getState()
        const worktreeId = state?.activeWorktreeId ?? null
        const cwd = Object.values(state?.worktreesByRepo ?? {})
          .flat()
          .find((row) => row.id === worktreeId)?.path
        return { worktreeId, cwd: cwd ?? null }
      })
      const { worktreeId, cwd } = active
      if (worktreeId === null || cwd === null) {
        throw new Error('No active worktree for the structured import')
      }
      const COMMANDS = 6
      const TURNS = 60
      /** Writes and imports a Codex transcript: settled turns of a prompt, six commands and an
       *  answer; `extra` more commands in the newest turn move the first window's start later. */
      const importTranscript = async (extra: number): Promise<string> => {
        const providerId = randomUUID()
        const folder = path.join(home, '.codex', 'sessions', '2026', '11', '25')
        mkdirSync(folder, { recursive: true })
        const records: unknown[] = [
          {
            type: 'session_meta',
            payload: {
              id: providerId,
              cwd,
              history_mode: 'paginated',
              cli_version: '0.162.1',
              source: 'vscode'
            },
            timestamp: '2026-11-25T12:00:00Z',
            ordinal: 0
          }
        ]
        const base = Date.parse('2026-11-25T12:00:00Z')
        for (let turn = 0; turn < TURNS; turn += 1) {
          const turnId = randomUUID()
          const start = base + turn * 20_000
          const event = (payload: unknown, offset: number) =>
            records.push({
              type: 'event_msg',
              payload,
              timestamp: new Date(start + offset).toISOString(),
              ordinal: records.length
            })
          const item = (body: unknown, offset: number) =>
            event(
              {
                type: 'item_completed',
                thread_id: providerId,
                turn_id: turnId,
                started_at_ms: start + offset,
                completed_at_ms: start + offset,
                item: body
              },
              offset
            )
          event(
            {
              type: 'task_started',
              turn_id: turnId,
              root_turn_id: turnId,
              started_at: start / 1000
            },
            0
          )
          item(
            {
              type: 'UserMessage',
              id: `user-${turn}`,
              content: [{ type: 'text', text: `Prompt ${turn}` }]
            },
            100
          )
          const commands = COMMANDS + (turn === TURNS - 1 ? extra : 0)
          for (let command = 0; command < commands; command += 1) {
            item(
              {
                type: 'CommandExecution',
                id: `exec-${turn}-${command}`,
                command: ['sh', '-c', `cat f${turn}-${command}.log`],
                cwd: `file://${cwd}`,
                parsed_cmd: [{ type: 'unknown', cmd: `cat f${turn}-${command}.log` }],
                status: 'completed',
                aggregated_output: `f ${turn} ${command} ok`,
                exit_code: 0,
                duration: { secs: 1, nanos: 0 }
              },
              1000 + command * 10
            )
          }
          item(
            {
              type: 'AgentMessage',
              id: `answer-${turn}`,
              content: [{ type: 'Text', text: `Answer ${turn}` }],
              phase: 'final_answer'
            },
            7000
          )
          event(
            {
              type: 'task_complete',
              turn_id: turnId,
              root_turn_id: turnId,
              started_at: start / 1000,
              completed_at: (start + 8000) / 1000,
              duration_ms: 8000
            },
            8000
          )
        }
        writeFileSync(
          path.join(folder, `rollout-2026-11-25T12-00-00-${providerId}.jsonl`),
          `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
        )
        const sessionId = createOrcaSessionId(randomUUID)
        const params = structuredAgentSessionCreateParams({
          sessionId,
          worktree: `id:${worktreeId}`,
          agent: 'codex',
          resumeFrom: { providerSessionId: providerId },
          randomUuid: randomUUID
        })
        const reply = await orcaPage.evaluate(
          (p) => window.api.runtime.call({ method: 'agentSession.create', params: p }),
          params
        )
        expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true })
        return sessionId
      }
      // Manual paging, so an older page lands only when asked.
      await orcaPage.evaluate(() => {
        Object.defineProperty(window, 'IntersectionObserver', {
          value: undefined,
          configurable: true
        })
      })
      const openSession = async (sessionId: string): Promise<Locator> => {
        const readTabId = () =>
          orcaPage.evaluate(
            ({ worktreeId, sessionId }) =>
              window.__store
                ?.getState()
                .unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.entityId === sessionId)?.id,
            { worktreeId, sessionId }
          )
        await expect.poll(readTabId, { timeout: 60_000 }).toBeTruthy()
        await orcaPage
          .locator(`[data-testid="sortable-tab"][data-tab-id="${await readTabId()}"]`)
          .click()
        const scroll = orcaPage.locator('[data-native-chat-scroll]').filter({ visible: true })
        await expect(scroll.getByText(`Answer ${TURNS - 1}`, { exact: true })).toBeAttached({
          timeout: 120_000
        })
        return scroll
      }
      // Window order within a turn: its prompt (0), its commands (1..6), its answer (7).
      const turnItems = COMMANDS + 2
      /** Where the opened chat's first window starts, read from what it draws at its top. */
      const windowStart = async (scroll: Locator) => {
        await wheelToTop(orcaPage, scroll)
        const closed = scroll.locator('[data-native-chat-tool-run-state][aria-expanded="false"]')
        if ((await closed.count()) > 0) {
          await closed.first().click()
          await settle(scroll)
        }
        return scroll.evaluate((root, turnItems) => {
          const header = root.querySelector('[data-native-chat-tool-run-state]')
          const text = Array.from(root.querySelectorAll('p')).find((node) =>
            /^(Prompt|Answer) \d+$/.test(node.textContent?.trim() ?? '')
          )
          const runFirst =
            header !== null &&
            (text === undefined ||
              Boolean(header.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING))
          if (runFirst) {
            const members = header
              .closest('[data-index]')
              ?.querySelector('[data-native-chat-tool-run-members]')
            const commands = [...(members?.textContent ?? '').matchAll(/cat f(\d+)-(\d+)\.log/g)]
              .map((match) => ({ turn: Number(match[1]), command: Number(match[2]) }))
              .sort((a, b) => a.command - b.command)
            const first = commands[0]
            return first ? { turn: first.turn, offset: 1 + first.command } : null
          }
          const [kind, turn] = text?.textContent?.trim().split(' ') ?? []
          return kind === undefined
            ? null
            : { turn: Number(turn), offset: kind === 'Prompt' ? 0 : turnItems - 1 }
        }, turnItems)
      }
      // Prompt only: the window starts at the run's first command. Prompt and earlier commands: it
      // starts four commands in, so two are loaded. Each extra command in the newest turn moves
      // the window's start one item later; calibrate against what this build pages, then use a
      // fresh import so the reader's journey starts untouched.
      const target = kase === 'prompt' ? 1 : 5
      let extra = 0
      let start = await windowStart(await openSession(await importTranscript(extra)))
      const tries: unknown[] = [{ extra, start }]
      for (let attempt = 0; attempt < 4 && start?.offset !== target; attempt += 1) {
        extra += (target - (start?.offset ?? 0) + turnItems) % turnItems || turnItems
        start = await windowStart(await openSession(await importTranscript(extra)))
        tries.push({ extra, start })
      }
      writeFileSync(path.join(OUT, `structured-${kase}-calibration.json`), JSON.stringify(tries))
      expect(start?.offset, `the first window starts where this case needs`).toBe(target)
      const turn = start?.turn ?? 0
      const scroll = await openSession(await importTranscript(extra))
      await pageOverRun(orcaPage, scroll, {
        lane: 'structured',
        kase,
        prompt: `Prompt ${turn}`,
        prefix: `f${turn}`,
        commands: COMMANDS,
        output: `f ${turn} ${COMMANDS - 1} ok`,
        place: (text) => {
          const prompt = /^Prompt (\d+)$/.exec(text)
          const answer = /^Answer (\d+)$/.exec(text)
          return prompt ? Number(prompt[1]) * 10 : answer ? Number(answer[1]) * 10 + 9 : null
        }
      })
    })
  }
})

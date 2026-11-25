// DISPOSABLE RUN HARNESS (not for merge): what happens to an opened run when an older page
// reaches its turn's prompt, terminal and structured lanes. Records JSON; asserts nothing.
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Locator, Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import { test, openStubChat, SUPPORTED } from '../session-fixtures/structured-claude-stub'
import { structuredAgentSessionCreateParams } from '../../../../src/shared/agent-session/lifecycle/operations/structured-agent-session-create'
import { createOrcaSessionId } from '../../../../src/shared/agent-session/identity/orca-session-address'
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
  settleScroll,
  nextFrames,
  toggleTerminalTabToChatView,
  activateTerminalTab,
  claudeTranscript,
  TRANSCRIPT_ROWS
} from './native-chat-history-prepend-session'
import { anchorWheelPages } from './zz-audit-anchor-gestures'

const OUT = process.env.AUDIT_OUT ?? os.tmpdir()
mkdirSync(OUT, { recursive: true })

/** What the reader sees: run headers, open members, turn status rows, the top visible text. */
function view(scroll: Locator) {
  return scroll.evaluate((root) => {
    const top = root.getBoundingClientRect().top
    const offset = (element: Element) => Math.round(element.getBoundingClientRect().top - top)
    const texts = Array.from(root.querySelectorAll('p'))
      .filter((p) => {
        const rect = p.getBoundingClientRect()
        return rect.bottom > top && rect.top < top + root.clientHeight
      })
      .map((p) => [p.textContent?.trim().slice(0, 40), offset(p)])
    return {
      scrollTop: root.scrollTop,
      height: root.scrollHeight,
      runs: Array.from(root.querySelectorAll('[data-native-chat-tool-run-state]')).map((h) => [
        h.textContent?.slice(0, 40),
        h.getAttribute('aria-expanded'),
        offset(h)
      ]),
      members: root.querySelectorAll(
        '[data-native-chat-tool-run-members] [data-native-chat-content-anchor]'
      ).length,
      turns: Array.from(root.querySelectorAll('[data-native-chat-turn-status]')).map((h) => [
        h.textContent?.slice(0, 30),
        h.getAttribute('aria-expanded'),
        offset(h)
      ]),
      texts: texts.slice(0, 6)
    }
  })
}

async function wheelToTop(page: Page, scroll: Locator) {
  await scroll.hover()
  for (let step = 0; step < 300; step += 1) {
    if ((await scroll.evaluate((root) => root.scrollTop)) === 0) {
      break
    }
    await page.mouse.wheel(0, -3_000)
    await nextFrames(page, 2)
  }
  await settleScroll(scroll)
}

/** Opens the oldest loaded run, then pages once and records before and after. */
async function pageOverOpenRun(page: Page, scroll: Locator, label: string) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await wheelToTop(page, scroll)
  const closed = scroll.locator('[data-native-chat-tool-run-state][aria-expanded="false"]').first()
  const hadRun = (await closed.count()) > 0
  if (hadRun) {
    await closed.click()
    await settleScroll(scroll)
  }
  // Read a little into the run, as a reader would, not from the transcript's very top edge.
  await page.mouse.wheel(0, Number(process.env.AUDIT_PARK ?? 60))
  await settleScroll(scroll)
  const before = await view(scroll)
  const load = page.getByRole('button', { name: 'Load earlier messages' })
  const height = before.height
  if ((await load.count()) > 0) {
    await load.evaluate((button: HTMLButtonElement) => button.click())
  } else {
    await page.mouse.wheel(0, -200)
  }
  await expect
    .poll(() => scroll.evaluate((root) => root.scrollHeight), { timeout: 60_000 })
    .not.toBe(height)
  await settleScroll(scroll)
  const after = await view(scroll)
  writeFileSync(
    path.join(OUT, `${label}.json`),
    JSON.stringify({ hadRun, before, after, errors }, null, 2)
  )
}

test.describe('An opened run at a prompt boundary', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await orcaPage.setViewportSize({ width: 1280, height: 900 })
  })

  test('terminal lane', async ({ orcaPage }) => {
    test.setTimeout(240_000)
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await waitForPaneIdentitySnapshot(orcaPage, 1)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await waitForPtyShellEcho(orcaPage, ptyId, 15_000)
    const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
    const [tabId] = descriptor.paneKey.split(':')
    const sessionId = `e2e-fold-${randomUUID()}`
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-fold-'))
    const transcriptPath = path.join(dir, `${sessionId}.jsonl`)
    // A completed turn whose prompt sits just above a run of eight commands; the first window
    // holds the run's tail, so the first older page brings the prompt (and settles the turn).
    let at = 0
    const line = (type: 'user' | 'assistant', content: unknown[]) =>
      JSON.stringify({
        sessionId,
        uuid: `${sessionId}-${(at += 1)}`,
        timestamp: new Date(Date.now() - 1_000_000 + at * 1_000).toISOString(),
        type,
        message: { id: `m-${at}`, role: type, model: 'claude-opus-4', content }
      })
    const older = Array.from({ length: 60 }, (_, index) =>
      line(index % 2 ? 'assistant' : 'user', [{ type: 'text', text: `Older row ${index}` }])
    )
    const run = Array.from({ length: 8 }, (_, index) => [
      line('assistant', [
        {
          type: 'tool_use',
          id: `c-${index}`,
          name: 'Bash',
          input: { command: `cat c-${index}.log` }
        }
      ]),
      line('user', [{ type: 'tool_result', tool_use_id: `c-${index}`, content: `c ${index} ok` }])
    ]).flat()
    const newer = Array.from({ length: 296 }, (_, index) =>
      line(index % 2 ? 'user' : 'assistant', [{ type: 'text', text: `Newer row ${index}` }])
    )
    writeFileSync(
      transcriptPath,
      `${[...older, line('user', [{ type: 'text', text: 'The run prompt' }]), ...run, ...newer].join('\n')}\n`
    )
    try {
      await enableNativeChatSetting(orcaPage)
      await seedClaudeProviderSession(orcaPage, {
        paneKey: descriptor.paneKey,
        worktreeId: descriptor.worktreeId,
        sessionId,
        transcriptPath
      })
      await orcaPage.evaluate(() => {
        Object.defineProperty(window, 'IntersectionObserver', {
          value: undefined,
          configurable: true
        })
      })
      await toggleTerminalTabToChatView(orcaPage, { tabId, worktreeId: descriptor.worktreeId })
      const scroll = orcaPage.locator('[data-native-chat-scroll]')
      await expect(orcaPage.locator('[data-native-chat-window]')).toBeVisible({ timeout: 30_000 })
      await pageOverOpenRun(orcaPage, scroll, 'terminal')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('structured lane', async ({ orcaPage, electronApp, claudeStub }) => {
    test.skip(!SUPPORTED)
    test.setTimeout(400_000)
    await openStubChat(orcaPage, claudeStub.command)
    await orcaPage.evaluate(async (fontSize) => {
      const settings = await window.api.settings.set({
        nativeChatAppearance: { fontSize, matchTerminalInterface: false }
      })
      window.__store?.setState({ settings })
    }, Number(process.env.AUDIT_FONT ?? 13))
    const home = await electronApp.evaluate(({ app }) => app.getPath('home'))
    const providerId = randomUUID()
    const { worktreeId, cwd } = await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      const worktreeId = state.activeWorktreeId!
      return {
        worktreeId,
        cwd: Object.values(state.worktreesByRepo)
          .flat()
          .find((row) => row.id === worktreeId)!.path
      }
    })
    const folder = path.join(home, '.codex', 'sessions', '2026', '11', '20')
    mkdirSync(folder, { recursive: true })
    const transcriptPath = path.join(folder, `rollout-2026-11-20T12-00-00-${providerId}.jsonl`)
    // Settled Codex turns, each a prompt then a run of commands then an answer.
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
        timestamp: '2026-11-20T12:00:00Z',
        ordinal: 0
      }
    ]
    const base = Date.parse('2026-11-20T12:00:00Z')
    for (let turn = 0; turn < 200; turn += 1) {
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
        { type: 'task_started', turn_id: turnId, root_turn_id: turnId, started_at: start / 1000 },
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
      for (let command = 0; command < 6; command += 1) {
        item(
          {
            type: 'CommandExecution',
            id: `exec-${turn}-${command}`,
            command: ['sh', '-c', `cat f-${turn}-${command}.log`],
            cwd: `file://${cwd}`,
            parsed_cmd: [{ type: 'unknown', cmd: `cat f-${turn}-${command}.log` }],
            status: 'completed',
            aggregated_output: 'ok',
            exit_code: 0,
            duration: { secs: 1, nanos: 0 }
          },
          1000 + command * 100
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
    writeFileSync(transcriptPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
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
    writeFileSync(path.join(OUT, 'structured-create.json'), JSON.stringify(reply))
    const readTabId = () =>
      orcaPage.evaluate(
        ({ worktreeId, sessionId }) =>
          window
            .__store!.getState()
            .unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.entityId === sessionId)?.id,
        { worktreeId, sessionId }
      )
    await expect.poll(readTabId, { timeout: 60_000 }).toBeTruthy()
    // Manual paging, so the first older page lands only when asked.
    await orcaPage.evaluate(() => {
      Object.defineProperty(window, 'IntersectionObserver', {
        value: undefined,
        configurable: true
      })
    })
    await orcaPage
      .locator(`[data-testid="sortable-tab"][data-tab-id="${await readTabId()}"]`)
      .click()
    await expect(orcaPage.getByText('Answer 199', { exact: true })).toBeAttached({
      timeout: 120_000
    })
    const scroll = orcaPage.locator('[data-native-chat-scroll]').last()
    await pageOverOpenRun(orcaPage, scroll, 'structured')
  })

  test('terminal hidden prefix', async ({ orcaPage }) => {
    test.setTimeout(240_000)
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await waitForPaneIdentitySnapshot(orcaPage, 1)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    await waitForPtyShellEcho(orcaPage, ptyId, 15_000)
    const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
    const [tabId] = descriptor.paneKey.split(':')
    const sessionId = `e2e-hidden-prefix-${randomUUID()}`
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-hidden-prefix-'))
    const transcriptPath = path.join(dir, `${sessionId}.jsonl`)
    writeFileSync(transcriptPath, claudeTranscript(TRANSCRIPT_ROWS, sessionId))
    try {
      await enableNativeChatSetting(orcaPage)
      await seedClaudeProviderSession(orcaPage, {
        paneKey: descriptor.paneKey,
        worktreeId: descriptor.worktreeId,
        sessionId,
        transcriptPath
      })
      await orcaPage.evaluate(() => {
        Object.assign(window, { __savedIntersectionObserver: window.IntersectionObserver })
        Object.defineProperty(window, 'IntersectionObserver', {
          value: undefined,
          configurable: true
        })
      })
      await toggleTerminalTabToChatView(orcaPage, { tabId, worktreeId: descriptor.worktreeId })
      const scroll = orcaPage.locator('[data-native-chat-scroll]')
      await expect(orcaPage.getByRole('button', { name: 'Load earlier messages' })).toBeAttached({
        timeout: 30_000
      })
      await scroll.hover()
      await orcaPage.mouse.wheel(0, -2_500)
      await settleScroll(scroll)
      const marker = () =>
        scroll.evaluate((root) => {
          const top = root.getBoundingClientRect().top
          const p = Array.from(root.querySelectorAll('p')).find(
            (node) =>
              /^E2E transcript row \d{4}$/.test(node.textContent?.trim() ?? '') &&
              node.getBoundingClientRect().top >= top
          )
          return p
            ? { text: p.textContent?.trim(), offset: p.getBoundingClientRect().top - top }
            : null
        })
      const reading = await marker()
      const heightBefore = await scroll.evaluate((root) => root.scrollHeight)
      // Ask for the page, then hide the chat before it can land.
      await orcaPage.evaluate((worktreeId) => {
        const load = Array.from(document.querySelectorAll('button')).find(
          (button) => button.textContent?.trim() === 'Load earlier messages'
        )
        load?.click()
        // The other tab's terminal needs the observer this test took away for manual paging.
        Object.defineProperty(window, 'IntersectionObserver', {
          value: (window as unknown as { __savedIntersectionObserver: unknown })
            .__savedIntersectionObserver,
          configurable: true
        })
        const state = window.__store!.getState()
        const tab = state.createTab(worktreeId, undefined, undefined, { activate: true })
        state.setActiveTab(tab.id)
        state.setActiveTabType('terminal', window.__store!.getState().activeWorktreeId)
      }, descriptor.worktreeId)
      // oxlint-disable-next-line playwright/no-wait-for-timeout -- disposable evidence: let the page land while hidden.
      await orcaPage.waitForTimeout(4_000)
      await activateTerminalTab(orcaPage, tabId)
      await expect(scroll).toBeVisible({ timeout: 15_000 })
      const firstFrame = await scroll.evaluate((root) => root.scrollHeight)
      await settleScroll(scroll)
      const after = await scroll.evaluate((root, text) => {
        const top = root.getBoundingClientRect().top
        const p = Array.from(root.querySelectorAll('p')).find(
          (node) => node.textContent?.trim() === text
        )
        const shown = Array.from(root.querySelectorAll('p'))
          .filter((node) => /^E2E transcript row \d{4}$/.test(node.textContent?.trim() ?? ''))
          .map((node) => node.textContent?.trim().slice(-4))
        return {
          offset: p ? p.getBoundingClientRect().top - top : null,
          height: root.scrollHeight,
          scrollTop: root.scrollTop,
          mounted: [shown[0], shown.at(-1)]
        }
      }, reading?.text)
      writeFileSync(
        path.join(OUT, 'hidden-prefix.json'),
        JSON.stringify(
          { reading, heightBefore, firstFrameHeightAfterReveal: firstFrame, after },
          null,
          2
        )
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('structured wheel matrix', async ({ orcaPage, electronApp, claudeStub }) => {
    test.skip(!SUPPORTED)
    test.setTimeout(600_000)
    await orcaPage.setViewportSize({ width: Number(process.env.AUDIT_WIDTH ?? 1280), height: 900 })
    await openStubChat(orcaPage, claudeStub.command)
    await orcaPage.evaluate(async (fontSize) => {
      const settings = await window.api.settings.set({
        nativeChatAppearance: { fontSize, matchTerminalInterface: false }
      })
      window.__store?.setState({ settings })
    }, Number(process.env.AUDIT_FONT ?? 13))
    const home = await electronApp.evaluate(({ app }) => app.getPath('home'))
    const providerId = randomUUID()
    const { worktreeId, cwd } = await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      const worktreeId = state.activeWorktreeId!
      return {
        worktreeId,
        cwd: Object.values(state.worktreesByRepo)
          .flat()
          .find((row) => row.id === worktreeId)!.path
      }
    })
    const folder = path.join(home, '.codex', 'sessions', '2026', '11', '20')
    mkdirSync(folder, { recursive: true })
    const transcriptPath = path.join(folder, `rollout-2026-11-20T13-00-00-${providerId}.jsonl`)
    // Settled turns with prose markers the gesture harness follows ("AUDIT row NNNNNN").
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
        timestamp: '2026-11-20T13:00:00Z',
        ordinal: 0
      }
    ]
    const base = Date.parse('2026-11-20T13:00:00Z')
    const audit = (index: number) => `AUDIT row ${String(index).padStart(6, '0')}`
    for (let turn = 0; turn < 600; turn += 1) {
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
        { type: 'task_started', turn_id: turnId, root_turn_id: turnId, started_at: start / 1000 },
        0
      )
      item(
        {
          type: 'UserMessage',
          id: `user-${turn}`,
          content: [{ type: 'text', text: audit(turn * 2) }]
        },
        100
      )
      item(
        {
          type: 'CommandExecution',
          id: `exec-${turn}`,
          command: ['sh', '-c', `cat f-${turn}.log`],
          cwd: `file://${cwd}`,
          parsed_cmd: [{ type: 'unknown', cmd: `cat f-${turn}.log` }],
          status: 'completed',
          aggregated_output: 'x'.repeat(Number(process.env.AUDIT_OUTPUT ?? 2000)),
          exit_code: 0,
          duration: { secs: 1, nanos: 0 }
        },
        4000
      )
      item(
        {
          type: 'AgentMessage',
          id: `answer-${turn}`,
          content: [{ type: 'Text', text: `${audit(turn * 2 + 1)}\n\nFinal answer.` }],
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
    writeFileSync(transcriptPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
    const sessionId = createOrcaSessionId(randomUUID)
    const params = structuredAgentSessionCreateParams({
      sessionId,
      worktree: `id:${worktreeId}`,
      agent: 'codex',
      resumeFrom: { providerSessionId: providerId },
      randomUuid: randomUUID
    })
    await orcaPage.evaluate(
      (p) => window.api.runtime.call({ method: 'agentSession.create', params: p }),
      params
    )
    const readTabId = () =>
      orcaPage.evaluate(
        ({ worktreeId, sessionId }) =>
          window
            .__store!.getState()
            .unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.entityId === sessionId)?.id,
        { worktreeId, sessionId }
      )
    await expect.poll(readTabId, { timeout: 60_000 }).toBeTruthy()
    await orcaPage
      .locator(`[data-testid="sortable-tab"][data-tab-id="${await readTabId()}"]`)
      .click()
    await expect(orcaPage.getByText(`${audit(1199)}`, { exact: false }).first()).toBeAttached({
      timeout: 120_000
    })
    const scroll = orcaPage.locator('[data-native-chat-scroll]').last()
    await scroll.hover()
    await orcaPage.mouse.wheel(0, -800)
    await settleScroll(scroll)
    const gestures = await anchorWheelPages(orcaPage, 3, scroll)
    writeFileSync(
      path.join(OUT, `structured-matrix-w${process.env.AUDIT_WIDTH ?? 1280}-f${process.env.AUDIT_FONT ?? 13}.json`),
      JSON.stringify(gestures)
    )
  })
})

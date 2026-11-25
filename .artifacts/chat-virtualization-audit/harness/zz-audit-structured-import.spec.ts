// Disposable: real adoption/import into journal, no live-turn seeding.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { loadavg } from 'node:os'
import path from 'node:path'
import { test, openStubChat, SUPPORTED } from './helpers/structured-claude-stub'
import { expect } from './helpers/orca-app'
import { structuredAgentSessionCreateParams, createStructuredAgentSessionId } from '../../src/shared/agent-session/structured-agent-session-create'
import { writeTranscript, marker } from './zz-audit-transcript'
import { memory } from './zz-audit-memory'

const OUT = process.env.AUDIT_OUT ?? '.artifacts/chat-virtualization-audit/data/import-baseline'
mkdirSync(OUT, { recursive: true })
test('audit hundreds of turns imported into structured journal', async ({ orcaPage, electronApp, claudeStub }) => {
  test.skip(!SUPPORTED)
  test.setTimeout(600_000)
  await orcaPage.setViewportSize({ width: 1280, height: 900 })
  await openStubChat(orcaPage, claudeStub.command)
  const result: Record<string, unknown> = { at: new Date().toISOString(), loadAverage: loadavg(), viewport: { width: 1280, height: 900 } }
  const home = await electronApp.evaluate(({ app }) => app.getPath('home'))
  const providerId = randomUUID()
  const { worktreeId, cwd } = await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    const worktreeId = state.activeWorktreeId!
    return { worktreeId, cwd: Object.values(state.worktreesByRepo).flat().find((row) => row.id === worktreeId)!.path }
  })
  const agent = process.env.AUDIT_PROVIDER === 'codex' ? 'codex' : 'claude'
  const folder = agent === 'codex' ? path.join(home, '.codex', 'sessions', '2026', '11', '14') : path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(folder, { recursive: true })
  const transcriptPath = path.join(folder, agent === 'codex' ? `rollout-2026-11-14T12-00-00-${providerId}.jsonl` : `${providerId}.jsonl`)
  const count = Number(process.env.AUDIT_ITEMS ?? 1200)
  if (agent === 'claude') {
    writeTranscript(transcriptPath, 'tools', count, providerId)
    writeFileSync(transcriptPath, readFileSync(transcriptPath, 'utf8').trimEnd().split('\n').map((line) => JSON.stringify({ ...JSON.parse(line), cwd })).join('\n') + '\n')
  } else {
    const records: unknown[] = [{ type: 'session_meta', payload: { id: providerId, cwd, history_mode: 'paginated', cli_version: '0.162.1', source: 'vscode' }, timestamp: '2026-11-14T12:00:00Z', ordinal: 0 }]
    const base = Date.parse('2026-11-14T12:00:00Z')
    for (let turn = 0; turn < count / 2; turn += 1) {
      const turnId = randomUUID()
      const start = base + turn * 20000
      const event = (payload: unknown, offset: number) => records.push({ type: 'event_msg', payload, timestamp: new Date(start + offset).toISOString(), ordinal: records.length })
      event({ type: 'task_started', turn_id: turnId, root_turn_id: turnId, started_at: start / 1000 }, 0)
      const item = (item: unknown, offset: number) => event({ type: 'item_completed', thread_id: providerId, turn_id: turnId, started_at_ms: start + offset, completed_at_ms: start + offset, item }, offset)
      item({ type: 'UserMessage', id: `user-${turn}`, content: [{ type: 'text', text: marker(turn * 2) }] }, 100)
      item({ type: 'CommandExecution', id: `exec-${turn}`, command: ['sh', '-c', `cat file-${turn}.log`], cwd: `file://${cwd}`, parsed_cmd: [{ type: 'unknown', cmd: `cat file-${turn}.log` }], status: 'completed', aggregated_output: 'x'.repeat(20000), exit_code: 0, duration: { secs: 1, nanos: 0 } }, 4000)
      item({ type: 'AgentMessage', id: `answer-${turn}`, content: [{ type: 'Text', text: marker(turn * 2 + 1) + '\n\nFinal answer.' }], phase: 'final_answer' }, 7000)
      event({ type: 'task_complete', turn_id: turnId, root_turn_id: turnId, started_at: start / 1000, completed_at: (start + 8000) / 1000, duration_ms: 8000 }, 8000)
    }
    writeFileSync(transcriptPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
  }
  const sessionId = createStructuredAgentSessionId(agent, randomUUID)
  const params = structuredAgentSessionCreateParams({ sessionId, worktree: `id:${worktreeId}`, agent, resumeFrom: { providerSessionId: providerId }, randomUuid: randomUUID })
  const before = Date.now()
  const reply = await orcaPage.evaluate((params) => window.api.runtime.call({ method: 'agentSession.create', params }), params)
  result.importCreateMs = Date.now() - before
  result.create = reply
  try {
    expect(reply).toMatchObject({ ok: true, result: { ok: true } })
    const readTabId = () => orcaPage.evaluate(({ worktreeId, sessionId }) => window.__store!.getState().unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.entityId === sessionId)?.id, { worktreeId, sessionId })
    await expect.poll(readTabId, { timeout: 30_000 }).toBeTruthy()
    const tabId = await readTabId()
    const opened = Date.now()
    await orcaPage.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`).click()
    await expect(orcaPage.getByText(marker(count - 1), { exact: true })).toBeAttached({ timeout: 120_000 })
    result.openMs = Date.now() - opened
    result.open = await memory(electronApp, orcaPage)
    const history = await orcaPage.evaluate(async (sessionId) => {
      const pages: unknown[] = []
      let cursor: unknown
      let total = 0
      for (let index = 0; index < 30; index += 1) {
        const started = performance.now()
        const response = await window.api.runtime.call({ method: 'agentSession.history', params: { sessionId, direction: cursor ? 'before' : 'tail', ...(cursor ? { cursor } : {}), limit: 200 } })
        const ms = performance.now() - started
        const result = response as { ok: boolean; result?: { page: { items: unknown[]; hasOlder: boolean; window: { oldest: unknown } } } }
        const page = result.result?.page
        pages.push({ index, ms, bytes: JSON.stringify(response).length, items: page?.items.length, window: page?.window, hasOlder: page?.hasOlder, error: page ? undefined : response })
        if (!page) break
        total += page.items.length
        cursor = page.window.oldest
        if (!page.hasOlder) break
      }
      return { pages, total }
    }, sessionId)
    result.history = history
    await orcaPage.screenshot({ path: path.join(OUT, 'structured-import-open.png') })
    const frames = await orcaPage.evaluate(async () => {
      const el = document.querySelector<HTMLElement>('[data-native-chat-scroll]')!
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }))
      const intervals: number[] = []
      let prior = performance.now()
      for (let index = 0; index < 400; index += 1) {
        el.scrollTop = Math.max(0, el.scrollTop - 400)
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        const now = performance.now()
        intervals.push(now - prior)
        prior = now
      }
      intervals.sort((a, b) => a - b)
      return { p50: intervals[200], p95: intervals[380], over33: intervals.filter((x) => x > 33).length }
    })
    result.scroll = frames
    result.afterScroll = await memory(electronApp, orcaPage)
    await orcaPage.screenshot({ path: path.join(OUT, 'structured-import-scrolled.png') })
  } finally {
    writeFileSync(path.join(OUT, 'structured-import.json'), JSON.stringify(result, null, 2))
  }
})

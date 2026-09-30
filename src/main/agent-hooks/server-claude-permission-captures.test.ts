// A permission card is up for exactly as long as its dialog is. Every hook body below is a real
// Claude Code 2.1.284 capture (src/shared/__fixtures__/claude-permission-*-hooks.jsonl, sidecars
// beside them) replayed in order through the server's own HTTP ingress. The captures established
// that a PermissionRequest never carries a tool_use_id, that its call's PreToolUse arrives first
// with identical input, that a failed command reports PostToolUseFailure only, and that a denied
// prompt fires no hook until the next typed prompt.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import { loadCapture, type CapturedHook } from './claude-cancel-capture.test-fixture'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Replay a whole capture and record the pane's state after every hook, with the card a wait shows. */
async function replay(name: string): Promise<string[]> {
  const server = new AgentHookServer()
  await server.start({ env: 'production' })
  try {
    const rows: string[] = []
    for (const record of loadCapture(name)) {
      if (record.kind !== 'hook') {
        continue
      }
      const hook: CapturedHook = record
      await expect(postHookEvent(server, buildBody(hook.payload))).resolves.toMatchObject({
        status: 204
      })
      const row = server.getStatusSnapshotForPane(PANE)[0]
      const card = row?.state === 'waiting' ? ` ${row.toolName} ${row.toolInput}` : ''
      rows.push(`${String(hook.payload.hook_event_name)}: ${row?.state}${card}`)
    }
    return rows
  } finally {
    server.stop()
  }
}

describe('Claude permission prompts (captured)', () => {
  // Two gated WebFetch calls queue two dialogs. The second-announced one is answered and completes
  // while the first dialog stays live for 81 s; only the first call's own completion clears it.
  it('holds the prompt still on screen when its parallel sibling completes', async () => {
    expect(await replay('claude-permission-parallel-hooks')).toEqual([
      'SessionStart: done',
      'UserPromptSubmit: working',
      'PreToolUse: working',
      'PostToolUse: working',
      'PostToolBatch: working',
      'PreToolUse: working',
      'PermissionRequest: waiting WebFetch https://example.com/',
      'PreToolUse: waiting WebFetch https://example.com/',
      'PermissionRequest: waiting WebFetch https://example.org/',
      // The answered call finished; the card moves to the dialog still live.
      'PostToolUse: waiting WebFetch https://example.com/',
      'Notification: waiting WebFetch https://example.com/',
      'PostToolUse: working',
      'PostToolBatch: working',
      'Stop: done',
      'MessageDisplay: done',
      'SessionEnd: done'
    ])
  })

  // An allowed command that exits non-zero reports PostToolUseFailure and never PostToolUse.
  it('clears the prompt when the approved command fails', async () => {
    expect(await replay('claude-permission-failure-hooks')).toEqual([
      'SessionStart: done',
      'UserPromptSubmit: working',
      'PreToolUse: working',
      'PermissionRequest: waiting Bash ./r2fail.sh s13 2',
      'PostToolUseFailure: working',
      'PostToolBatch: working',
      'Stop: done',
      'MessageDisplay: done',
      'SessionEnd: done'
    ])
  })

  // Out of scope for STA-3049, pinned so a change is deliberate: a denied prompt fires no hook, so
  // its card lingers until the next typed prompt starts a turn.
  it('keeps a denied prompt until the next prompt, which is the first hook after it', async () => {
    expect(await replay('claude-permission-deny-hooks')).toEqual([
      'SessionStart: done',
      'UserPromptSubmit: working',
      'PreToolUse: working',
      'PermissionRequest: waiting Bash ./r2wait.sh s5 25',
      'UserPromptSubmit: working',
      'MessageDisplay: working',
      'Stop: done',
      'SessionEnd: done'
    ])
  })
})

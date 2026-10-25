import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AgentHookServer } from './server'
import { buildBody, postHookEvent } from './server.test-fixtures'

// Shapes captured from Codex 0.164: a /side fork is its own session with no rollout.
const MAIN = '01a16f91-ac03-73f2-acdc-2bc83dbedce3'
const SIDE = '01a16f91-c78b-7420-b400-e3d4afc8626a'
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('keeps the main Codex turn working through a /side chat after Orca restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-side-thread-'))
  dirs.push(dir)
  const userDataPath = join(dir, 'user-data')
  const transcriptPath = join(dir, `rollout-${MAIN}.jsonl`)
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-main' } })}\n`
  )
  const main = { session_id: MAIN, transcript_path: transcriptPath }
  const side = { session_id: SIDE, transcript_path: null }
  const post = async (payload: Record<string, unknown>): Promise<void> => {
    expect((await postHookEvent(server, buildBody(payload), '/hook/codex')).status).toBe(204)
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      prompt: 'main task',
      providerSession: { id: MAIN }
    })
  }
  let server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath })
  try {
    await postHookEvent(
      server,
      buildBody({ ...main, hook_event_name: 'SessionStart', source: 'startup' }),
      '/hook/codex'
    )
    await post({
      ...main,
      hook_event_name: 'UserPromptSubmit',
      turn_id: 'turn-main',
      prompt: 'main task'
    })
    await post({ ...side, hook_event_name: 'SessionStart', source: 'fork' })
    // Terminals outlive the app, so the side chat continues while every listener cache starts empty.
    server.stop()
    server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    await post({
      ...side,
      hook_event_name: 'UserPromptSubmit',
      turn_id: 'turn-side',
      prompt: 'side chat'
    })
    await post({ ...side, hook_event_name: 'SessionStart', source: 'compact' })
    await post({ ...side, hook_event_name: 'Stop', turn_id: 'turn-side' })
    await postHookEvent(
      server,
      buildBody({ ...main, hook_event_name: 'Stop', turn_id: 'turn-main' }),
      '/hook/codex'
    )
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'done' })
  } finally {
    server.stop()
  }
})

it('lets a new ephemeral Codex conversation take over a pane whose last turn finished', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-side-thread-'))
  dirs.push(dir)
  const server = new AgentHookServer()
  await server.start({ env: 'production' })
  try {
    const main = { session_id: MAIN, transcript_path: join(dir, 'rollout-main.jsonl') }
    await postHookEvent(
      server,
      buildBody({ ...main, hook_event_name: 'UserPromptSubmit', prompt: 'main task' }),
      '/hook/codex'
    )
    await postHookEvent(server, buildBody({ ...main, hook_event_name: 'Stop' }), '/hook/codex')
    const next = { session_id: SIDE, transcript_path: null }
    await postHookEvent(
      server,
      buildBody({ ...next, hook_event_name: 'SessionStart', source: 'startup' }),
      '/hook/codex'
    )
    await postHookEvent(
      server,
      buildBody({ ...next, hook_event_name: 'UserPromptSubmit', prompt: 'next task' }),
      '/hook/codex'
    )
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      state: 'working',
      prompt: 'next task',
      providerSession: { id: SIDE }
    })
  } finally {
    server.stop()
  }
})

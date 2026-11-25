import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CURSOR_LAUNCH_SPEC } from '../../../cursor/cursor-acp-launch-spec'
import { acpLaunchInstructions } from '../../launch/acp-instructions'
import { initializeAcpStructuredSession } from './acp-structured-handshake'

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function readRules(cwd: string): Promise<string[]> {
  const dir = join(cwd, '.cursor', 'rules')
  const names = await readdir(dir).catch(() => [])
  return Promise.all(names.map((name) => readFile(join(dir, name), 'utf8')))
}

/** Opens a Cursor chat against a stub agent that, like cursor-agent, reads the folder's rules when a
 *  session opens; the stub then exits, ending the start right after the open. */
async function openCursorChat(resumeSessionId: string | null) {
  const cwd = await mkdtemp(join(tmpdir(), 'orca-cursor-open-'))
  const dataDirectory = await mkdtemp(join(tmpdir(), 'orca-cursor-data-'))
  folders.push(cwd, dataDirectory)
  const instructions = await acpLaunchInstructions(CURSOR_LAUNCH_SPEC, dataDirectory, {
    sessionId: 'chat-1',
    text: 'Standing instructions for this chat',
    env: {},
    cwd
  })
  const opens: { method: 'session/new' | 'session/load'; rules: string[] }[] = []
  let exited = false
  const connection = {
    get exited() {
      return exited
    },
    closed: false,
    stderrTail: () => '',
    initialize: async () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }),
    start: async (params: { sessionId?: string }) => {
      opens.push({
        method: params.sessionId ? 'session/load' : 'session/new',
        rules: await readRules(cwd)
      })
      exited = true
      return {
        kind: params.sessionId ? 'loaded' : 'new',
        sessionId: 'cursor-session',
        response: {}
      }
    }
  }
  const launch = {
    spec: CURSOR_LAUNCH_SPEC,
    cwd,
    env: {},
    ...instructions,
    resume: resumeSessionId
      ? { sessionId: resumeSessionId, key: 'k', mayBeUnsaved: async () => false, lossKeys: [] }
      : undefined
  }
  const lane = { dispose: () => {}, translator: { finishLoad: () => {} } }
  const started = initializeAcpStructuredSession({
    acquire: { identity: { sessionId: 'chat-1' }, fence: 1 },
    signal: new AbortController().signal,
    deps: {},
    launch,
    connection,
    options: { adoptInitialize: () => {}, adoptSession: () => {} },
    child: {
      ended: false,
      closeRequested: false,
      journalClosed: null,
      connection,
      spec: launch.spec
    },
    abandoned: () => false,
    lanes: { create: () => lane, clear: () => {}, finishLoad: () => null }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the start ends right after the open, so only the members above are read.
  } as unknown as Parameters<typeof initializeAcpStructuredSession>[0])
  await expect(started).rejects.toThrow('closed while starting')
  return { opens, rulesAfter: await readRules(cwd), dotCursor: await readdir(cwd) }
}

describe('a Cursor chat open', () => {
  it('places the standing instructions rule for a reopen and removes it afterwards', async () => {
    const { opens, rulesAfter, dotCursor } = await openCursorChat('cursor-session')
    expect(opens).toHaveLength(1)
    expect(opens[0].method).toBe('session/load')
    expect(opens[0].rules).toHaveLength(1)
    expect(opens[0].rules[0]).toContain('alwaysApply: true')
    expect(opens[0].rules[0]).toContain('Standing instructions for this chat')
    expect(rulesAfter).toEqual([])
    expect(dotCursor).toEqual([])
  })

  it('places it for a new session the same way', async () => {
    const { opens, rulesAfter, dotCursor } = await openCursorChat(null)
    expect(opens.map((open) => [open.method, open.rules.length])).toEqual([['session/new', 1]])
    expect(rulesAfter).toEqual([])
    expect(dotCursor).toEqual([])
  })
})

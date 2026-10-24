import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { AgentHookServer } from '../agent-hooks/server'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { makePaneKey } from '../../shared/stable-pane-id'
import {
  createAgentStatusExtensionHarness,
  type HookContext
} from './agent-status-extension-test-harness'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const paneKey = makePaneKey('real-pi-managers', '44444444-4444-4444-8444-444444444444')
class Sink extends AgentHookServer {
  accept(body: unknown) {
    const event = normalizeHookPayload(this.state, 'pi', body, 'production')
    if (event) {
      this.applyNormalizedStatus(event)
    }
    return event
  }
  savedSession() {
    return JSON.parse(this.serializeStatusFile()).entries[paneKey]?.providerSession
  }
}

// The pinned-package smoke supplies this path; ordinary unit runs need no provider install.
it.skipIf(!process.env.ORCA_PI_TEST_PACKAGE)(
  'keeps real Pi managers selected across helper creation and runtime replacement',
  async () => {
    const root = process.env.ORCA_PI_TEST_PACKAGE!
    expect(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version).toBe('1.3.0')
    const { SessionManager } = await import(
      /* @vite-ignore */ pathToFileURL(join(root, 'dist/core/session-manager.js')).href
    )
    const directory = await mkdtemp(join(tmpdir(), 'orca-pi-session-'))
    const sink = new Sink()
    const sdkSessions = new Set<{ dispose: () => void }>()
    try {
      const append = (manager: ReturnType<typeof SessionManager.create>) =>
        manager.appendMessage({
          role: 'assistant',
          content: [{ type: 'text', text: 'saved reply' }],
          timestamp: Date.now()
        })
      const lead = SessionManager.create(directory, join(directory, 'lead'))
      append(lead)
      const accepted: ReturnType<typeof normalizeHookPayload>[] = []
      const h = createAgentStatusExtensionHarness({
        kind: 'pi',
        argv: ['node', join(root, 'dist/cli.js')],
        existsSync: () => true,
        env: {
          ORCA_PANE_KEY: paneKey,
          ORCA_TAB_ID: 'real-pi-managers',
          ORCA_AGENT_HOOK_ENV: 'production',
          ORCA_AGENT_HOOK_VERSION: '1'
        },
        fetchImpl: async (_url, init) => {
          accepted.push(sink.accept(JSON.parse(String(init?.body))))
          return { ok: true }
        }
      })
      await h.callHook('session_start', { reason: 'startup' }, { sessionManager: lead })
      await h.callHook('agent_start', {}, { sessionManager: lead })
      await h.callHook('tool_execution_start', { toolName: 'task' }, { sessionManager: lead })
      const helper = SessionManager.create(directory, join(directory, 'helper'), {
        parentSession: lead.getSessionFile()
      })
      append(helper)
      expect(helper.getHeader().parentSession).toBe(lead.getSessionFile())
      const child = h.registerSession()
      await child.callHook('session_start', { reason: 'startup' }, { sessionManager: helper })
      await child.callHook('agent_start', {}, { sessionManager: helper })
      await vi.waitFor(() => expect(accepted.length).toBeGreaterThan(0))
      expect(accepted.every((event) => event?.providerSession?.id === lead.getSessionId())).toBe(
        true
      )
      await h.callHook('agent_end', {}, { sessionManager: lead })
      await child.callHook(
        'message_end',
        { message: { role: 'assistant', content: 'helper answer' } },
        { sessionManager: helper }
      )
      await child.callHook('agent_end', {}, { sessionManager: helper })
      await vi.waitFor(() => expect(accepted.at(-1)?.payload.state).toBe('done'))
      expect(sink.savedSession()).toMatchObject({
        id: lead.getSessionId(),
        transcriptPath: lead.getSessionFile()
      })
      const [
        { createAgentSession },
        { DefaultResourceLoader },
        { SettingsManager },
        { ModelRuntime }
      ] = await Promise.all([
        import(/* @vite-ignore */ pathToFileURL(join(root, 'dist/core/sdk.js')).href),
        import(/* @vite-ignore */ pathToFileURL(join(root, 'dist/core/resource-loader.js')).href),
        import(/* @vite-ignore */ pathToFileURL(join(root, 'dist/core/settings-manager.js')).href),
        import(/* @vite-ignore */ pathToFileURL(join(root, 'dist/core/model-runtime.js')).href)
      ])
      const modelRuntime = await ModelRuntime.create({
        authPath: join(directory, 'isolated-auth.json'),
        modelsPath: null,
        allowModelNetwork: false
      })
      const createSdkSource = async (name: string) => {
        const child = h.registerSession()
        const settingsManager = SettingsManager.inMemory({ cacheWarming: 'off' })
        const resourceLoader = new DefaultResourceLoader({
          cwd: directory,
          agentDir: join(directory, name),
          settingsManager,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          extensionFactories: [
            (api: {
              on: (
                name: string,
                handler: (event: Record<string, unknown>, ctx: HookContext) => Promise<void>
              ) => void
            }) => {
              for (const hook of [
                'session_start',
                'tool_call',
                'tool_execution_start',
                'tool_execution_end',
                'session_shutdown'
              ]) {
                api.on(hook, (event, ctx) => child.callHook(hook, event, ctx))
              }
            }
          ]
        })
        await resourceLoader.reload()
        expect(resourceLoader.getExtensions().errors).toEqual([])
        const { session } = await createAgentSession({
          cwd: directory,
          agentDir: join(directory, name),
          sessionManager: SessionManager.inMemory(directory),
          settingsManager,
          resourceLoader,
          modelRuntime,
          noTools: 'all'
        })
        sdkSessions.add(session)
        const errors: unknown[] = []
        const setWidget = vi.fn()
        await session.bindExtensions({
          mode: 'interactive',
          uiContext: { setWidget, onTerminalInput: () => () => {}, notify: vi.fn() },
          onError: (error: unknown) => errors.push(error)
        })
        const ctx = session.extensionRunner.createContext()
        expect(ctx.hasUI).toBe(true)
        expect(ctx.isIdle()).toBe(true)
        ctx.ui.setWidget('question', [name])
        expect(setWidget).toHaveBeenCalledWith('question', [name])
        for (const type of ['tool_call', 'tool_execution_start']) {
          await session.extensionRunner.emit({
            type,
            toolName: 'ask_user_question',
            toolCallId: `call-${name}`,
            [type === 'tool_call' ? 'input' : 'args']: {
              questions: [{ id: 'choice', question: `${name}?`, options: ['yes', 'no'] }]
            }
          })
        }
        expect(errors).toEqual([])
        return {
          session,
          ctx,
          dispose: () => {
            session.dispose()
            sdkSessions.delete(session)
          }
        }
      }
      const hidden = await createSdkSource('hidden SDK')
      const visible = await createSdkSource('visible SDK')
      await vi.waitFor(() =>
        expect(accepted.at(-1)?.payload.interactivePrompt).toContain('visible SDK?')
      )
      const leadSubscriptions = h.fetchMock.mock.calls.length
      // Native disposal invalidates captured getters without a shutdown observation.
      hidden.dispose()
      expect(() => hidden.ctx.sessionManager).toThrow()
      expect(visible.ctx.sessionManager).toBe(visible.session.sessionManager)
      await h.callHook(
        'message_end',
        { message: { role: 'assistant', content: 'After hidden SDK disposal' } },
        { sessionManager: lead }
      )
      await vi.waitFor(() =>
        expect(h.fetchMock.mock.calls.length).toBeGreaterThan(leadSubscriptions)
      )
      expect(accepted.at(-1)?.payload).toMatchObject({
        state: 'blocked',
        lastAssistantMessage: 'After hidden SDK disposal'
      })
      expect(accepted.at(-1)?.payload.interactivePrompt).toContain('visible SDK?')
      await visible.session.extensionRunner.emit({
        type: 'tool_execution_end',
        toolName: 'ask_user_question',
        toolCallId: 'call-visible SDK',
        result: { content: [{ type: 'text', text: 'yes' }] },
        isError: false
      })
      await vi.waitFor(() => expect(accepted.at(-1)?.payload.interactivePrompt).toBeUndefined())
      visible.dispose()
      expect(() => visible.ctx.sessionManager).toThrow()
      await h.callHook(
        'message_end',
        { message: { role: 'assistant', content: 'After SDK disposal' } },
        { sessionManager: lead }
      )
      await vi.waitFor(() =>
        expect(accepted.at(-1)?.payload.lastAssistantMessage).toBe('After SDK disposal')
      )
      expect(accepted.at(-1)?.payload.interactivePrompt).toBeUndefined()
      expect(accepted.at(-1)?.providerSession?.id).toBe(lead.getSessionId())
      let manager = lead
      let runtime = { callHook: h.callHook }
      for (const reason of ['new', 'resume', 'fork', 'reload'] as const) {
        const previousSessionFile = manager.getSessionFile()
        const next =
          reason === 'new'
            ? SessionManager.create(directory, join(directory, 'new'))
            : reason === 'resume'
              ? SessionManager.open(helper.getSessionFile())
              : reason === 'fork'
                ? SessionManager.open(manager.getSessionFile())
                : manager
        if (reason === 'fork') {
          next.createBranchedSession(next.getLeafId())
          expect(next.getHeader().parentSession).toBe(previousSessionFile)
        }
        append(next)
        await runtime.callHook(
          'session_shutdown',
          { reason, targetSessionFile: next.getSessionFile() },
          { sessionManager: manager }
        )
        runtime = h.registerSession()
        manager = next
        await runtime.callHook(
          'session_start',
          { reason, ...(reason === 'reload' ? {} : { previousSessionFile }) },
          { sessionManager: manager }
        )
        await runtime.callHook('agent_start', {}, { sessionManager: manager })
        await vi.waitFor(() =>
          expect(accepted.at(-1)?.providerSession?.id).toBe(manager.getSessionId())
        )
        expect(sink.savedSession()).toMatchObject({
          id: manager.getSessionId(),
          transcriptPath: manager.getSessionFile()
        })
      }
      const fileless = createAgentStatusExtensionHarness({
        kind: 'pi',
        argv: ['node', join(root, 'dist/cli.js'), '--no-session']
      })
      manager = SessionManager.inMemory(directory)
      runtime = { callHook: fileless.callHook }
      await runtime.callHook('session_start', { reason: 'startup' }, { sessionManager: manager })
      for (const reason of ['new', 'fork'] as const) {
        await runtime.callHook(
          'session_shutdown',
          { reason, targetSessionFile: undefined },
          { sessionManager: manager }
        )
        if (reason === 'new') {
          manager = SessionManager.inMemory(directory)
        } else {
          manager.newSession()
        }
        const count = fileless.fetchMock.mock.calls.length
        runtime = fileless.registerSession()
        await runtime.callHook(
          'session_start',
          { reason, previousSessionFile: undefined },
          { sessionManager: manager }
        )
        await runtime.callHook('agent_start', {}, { sessionManager: manager })
        await vi.waitFor(() => expect(fileless.fetchMock.mock.calls.length).toBeGreaterThan(count))
        expect(
          JSON.parse(String(fileless.fetchMock.mock.calls.at(-1)?.[1]?.body)).payload
        ).not.toHaveProperty('session_file')
      }
    } finally {
      for (const session of sdkSessions) {
        session.dispose()
      }
      await rm(directory, { recursive: true, force: true })
    }
  }
)

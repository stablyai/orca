import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

const installed = vi.hoisted(() => {
  const state: {
    deps: Record<string, unknown> | null
    logger: StructuredAgentSessionLogger | null
  } = { deps: null, logger: null }
  return state
})

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

vi.mock('./structured-agent-session-runtime', () => ({
  ensureStructuredAgentSessionHost: vi.fn(
    async (deps: Record<string, unknown> & { logger: StructuredAgentSessionLogger }) => {
      installed.deps = deps
      installed.logger = deps.logger
    }
  )
}))

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OrcaRuntimeService } from './orca-runtime'
import { _resetTracerForTests, setActiveSink } from '../observability/tracer'
import type { StructuredAgentSessionStatusSink } from '../native-chat/agent-session-wire/structured-agent-session-status-feed'

type OrcaRuntimeDeps = NonNullable<ConstructorParameters<typeof OrcaRuntimeService>[2]>

/** Renaming either option reddens this list, and dropping either from a host's construction
 *  reddens the assertion below. Both are needed: the runtime class does not typecheck its own
 *  `this` calls, and each entry point wires the store separately. */
const AGENT_STATUS_STORE_DEPS = [
  'getAgentStatusSnapshot',
  'structuredAgentStatusSink'
] as const satisfies readonly (keyof OrcaRuntimeDeps)[]

const MAIN_ROOT = join(import.meta.dirname, '..')

/** The text of the `new OrcaRuntimeService(...)` call in one entry point. */
function runtimeConstruction(relativePath: string): string {
  const source = readFileSync(join(MAIN_ROOT, relativePath), 'utf8')
  const start = source.indexOf('new OrcaRuntimeService(')
  expect(start).toBeGreaterThanOrEqual(0)
  let depth = 0
  for (let index = source.indexOf('(', start); index < source.length; index += 1) {
    const character = source[index]
    if (character === '(') {
      depth += 1
    } else if (character === ')') {
      depth -= 1
      if (depth === 0) {
        return source.slice(start, index + 1)
      }
    }
  }
  throw new Error(`unbalanced OrcaRuntimeService construction in ${relativePath}`)
}

/** The runtime class this wiring lives on does not typecheck its own `this` calls, so a misnamed
 *  field here would install a host that never writes to the agent-status store — and every reader
 *  of that store would simply list no structured sessions. Pin it behaviourally. */
/** `worktree ps` reads structured rows only from the agent-status store, so an entry point that
 *  constructs a runtime without these lists no agents at all — and `orcad` serves `worktree.ps`
 *  and `agentSession.*` exactly like the desktop does. */
describe('every host that constructs a runtime wires the agent-status store', () => {
  it.each([['orcad/orcad-entry.ts'], ['startup/main-process-runtime-service.ts']])(
    '%s passes both store deps',
    (relativePath) => {
      const construction = runtimeConstruction(relativePath)
      for (const dep of AGENT_STATUS_STORE_DEPS) {
        expect(construction).toContain(`${dep}:`)
      }
      // A sink without it leaves the host holding no child records for that entry point.
      expect(construction).toContain('publishChildWork: (subject, evidence, provider) =>')
      expect(construction).toContain('ingestStructuredChildWork(subject, evidence, provider)')
      // Without it the summary and the chat strip read no child records on that entry point.
      expect(construction).toContain(
        'readChildWork: (subject) => agentHookServer.getStructuredChildWorkViews(subject)'
      )
    }
  )
})

describe('structured status sink wiring', () => {
  afterEach(() => {
    _resetTracerForTests()
    vi.restoreAllMocks()
  })

  it('hands the host the sink the runtime was constructed with', async () => {
    installed.deps = null
    const sink: StructuredAgentSessionStatusSink = { publish: vi.fn(), forget: vi.fn() }
    const runtime = new OrcaRuntimeService(null, undefined, { structuredAgentStatusSink: sink })

    await runtime.ensureStructuredAgentSessionHost()

    expect(installed.deps?.['statusSink']).toBe(sink)
  })

  // The runtime class does not typecheck its own calls, so the required logger is pinned here:
  // a logger that writes nowhere would pass every host test while the desktop dropped failures.
  it('hands the host the trace-file logger', async () => {
    installed.logger = null
    const push = vi.fn()
    setActiveSink({ push, flush: () => {}, close: () => {} })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const runtime = new OrcaRuntimeService()

    await runtime.ensureStructuredAgentSessionHost()
    const installedLogger = (): StructuredAgentSessionLogger | null => installed.logger
    installedLogger()?.warn('renewing a chat lease failed', {
      scope: 'lease-renewal',
      sessionId: 'session-1',
      error: new Error('database is locked')
    })

    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'agentSession.lease-renewal',
        attributes: expect.objectContaining({ sessionId: 'session-1' }),
        exit: expect.objectContaining({ _tag: 'Failure' })
      })
    )
  })

  it('installs without a sink when none was provided', async () => {
    installed.deps = null
    const runtime = new OrcaRuntimeService()

    await runtime.ensureStructuredAgentSessionHost()

    expect(installed.deps).not.toBeNull()
    expect('statusSink' in (installed.deps ?? {})).toBe(false)
  })
})

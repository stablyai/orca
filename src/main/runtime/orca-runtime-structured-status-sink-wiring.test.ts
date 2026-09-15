import { beforeAll, describe, expect, it, vi } from 'vitest'

const installed = vi.hoisted(() => ({ deps: null as Record<string, unknown> | null }))

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

vi.mock('./structured-agent-session-runtime', () => ({
  ensureStructuredAgentSessionHost: vi.fn(async (deps: Record<string, unknown>) => {
    installed.deps = deps
  })
}))

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { OrcaRuntimeService } from './orca-runtime'
import type { StructuredAgentSessionStatusSink } from '../native-chat/agent-session-wire/structured-agent-session-status-feed'
import { createLocalFileSink } from '../observability/local-file-sink'
import { setActiveSink } from '../observability/tracer'
import { setAppEnvironment } from '../../shared/app-environment'

type OrcaRuntimeDeps = NonNullable<ConstructorParameters<typeof OrcaRuntimeService>[2]>

/** Renaming either option reddens this list, and dropping either from a host's construction
 *  reddens the assertion below. Both are needed: the runtime class does not typecheck its own
 *  `this` calls, and each entry point wires the store separately. */
const AGENT_STATUS_STORE_DEPS = [
  'getAgentStatusSnapshot',
  'structuredAgentStatusSink'
] as const satisfies readonly (keyof OrcaRuntimeDeps)[]

const MAIN_ROOT = join(import.meta.dirname, '..')

beforeAll(() => {
  setAppEnvironment({
    getPath: () => '/tmp',
    getAppPath: () => '/tmp',
    getVersion: () => '0.0.0-test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
})

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
    }
  )
})

describe('structured status sink wiring', () => {
  it.each([new TypeError('journal settlement failed'), 'late settlement failed'])(
    'persists the installer error and scope through the real trace sink: %s',
    async (error) => {
      installed.deps = null
      const directory = mkdtempSync(join(import.meta.dirname, '.structured-error-trace-'))
      const filePath = join(directory, 'logs', 'main.trace.ndjson')
      const sink = createLocalFileSink({ filePath })
      setActiveSink(sink)
      try {
        await new OrcaRuntimeService().ensureStructuredAgentSessionHost()

        const deps: Record<string, unknown> = installed.deps ?? {}
        const onError = deps['onError']
        expect(onError).toBeTypeOf('function')
        if (typeof onError !== 'function') {
          throw new Error('structured runtime installer omitted onError')
        }
        onError({ scope: 'structured-agent-session-journal:session-1', error })

        await vi.waitFor(() => {
          const records: unknown[] = readFileSync(filePath, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
          expect(records).toEqual([
            expect.objectContaining({
              type: 'effect-span',
              name: 'agent-session.error',
              attributes: { scope: 'structured-agent-session-journal:session-1' },
              exit: {
                _tag: 'Failure',
                cause: expect.stringContaining(String(error))
              }
            })
          ])
          if (error instanceof Error) {
            expect(records[0]).toMatchObject({
              exit: {
                cause: expect.stringContaining('orca-runtime-structured-status-sink-wiring.test.ts')
              }
            })
          }
        })
      } finally {
        setActiveSink(null)
        sink.close()
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )

  it('hands the host the sink the runtime was constructed with', async () => {
    installed.deps = null
    const sink: StructuredAgentSessionStatusSink = { publish: vi.fn(), forget: vi.fn() }
    const runtime = new OrcaRuntimeService(null, undefined, { structuredAgentStatusSink: sink })

    await runtime.ensureStructuredAgentSessionHost()

    expect(installed.deps?.['statusSink']).toBe(sink)
  })

  it('installs without a sink when none was provided', async () => {
    installed.deps = null
    const runtime = new OrcaRuntimeService()

    await runtime.ensureStructuredAgentSessionHost()

    expect(installed.deps).not.toBeNull()
    expect('statusSink' in (installed.deps ?? {})).toBe(false)
  })
})

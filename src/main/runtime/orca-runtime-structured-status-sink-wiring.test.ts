import { describe, expect, it, vi } from 'vitest'

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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OrcaRuntimeService } from './orca-runtime'
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
    }
  )
})

describe('structured status sink wiring', () => {
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

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DAP_ADAPTERS, probeDebugpy, resolveDebugAdapter } from './dap-adapter-registry'
import { DebugBreakpointStore } from './debug-breakpoint-store'
import { DebugSession, type DebugSessionState } from './debug-session'
import { resolveLaunchSpec } from './launch-config'

const PYTHON = process.env.ORCA_DEBUG_LIVE_PYTHON
const FIXTURES = join(__dirname, '__fixtures__')
const TARGET = join(FIXTURES, 'live_debug_target.py')
const LIVE_TIMEOUT_MS = 90_000
const cleanups: (() => unknown)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

function waitFor(
  session: DebugSession,
  done: (s: DebugSessionState) => boolean
): Promise<DebugSessionState> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`state stayed ${JSON.stringify(session.state)}`)),
      LIVE_TIMEOUT_MS / 2
    )
    const check = (state: DebugSessionState): void => {
      if (done(state)) {
        clearTimeout(timer)
        off()
        resolve(state)
      }
    }
    const off = session.onStateChange(check)
    check(session.state)
  })
}

describe('DebugSession against real debugpy', () => {
  it(
    'stops on the breakpoint, inspects, steps, and runs to the end',
    async (ctx) => {
      if (!PYTHON) {
        console.warn(
          '[debug] skipping the live debugpy test: set ORCA_DEBUG_LIVE_PYTHON to a python with debugpy'
        )
        ctx.skip()
        return
      }
      const python = PYTHON
      const resolved = await resolveLaunchSpec({
        worktreePath: FIXTURES,
        filePath: TARGET,
        adapterOptions: { settings: { debugPythonPath: python } }
      })
      if (!resolved.ok) {
        throw new Error(resolved.message)
      }
      const row = DAP_ADAPTERS.find((r) => r.id === resolved.spec.adapterId)
      const adapter =
        row && (await resolveDebugAdapter(row, { settings: { debugPythonPath: python } }))
      if (!adapter?.ok) {
        throw new Error(`no debugpy adapter for ${python}`)
      }
      // Set but unusable is a failure, never a skip.
      const approval = { approvalKey: adapter.approvalKey, approvedKeys: [adapter.approvalKey] }
      const probe = await probeDebugpy(python, approval)
      expect(probe, `${python} cannot import debugpy`).toEqual({ ok: true })
      const lines = readFileSync(TARGET, 'utf8').split('\n')
      const bpLine = lines.findIndex((line) => line.includes('c = a + b')) + 1
      const dir = mkdtempSync(join(tmpdir(), 'orca-live-debugpy-'))
      cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
      const store = new DebugBreakpointStore({ filePath: join(dir, 'breakpoints.json') })
      store.add(FIXTURES, TARGET, { line: bpLine })
      const session = new DebugSession({
        spec: resolved.spec,
        // As createTrustedSession does: the adapter's cwd is never the worktree.
        command: { program: adapter.binaryPath, args: adapter.spawnArgs, cwd: homedir() },
        worktreeRoot: FIXTURES,
        breakpoints: store
      })
      cleanups.push(() => session.dispose())

      await session.start()
      const stopped = await waitFor(session, (s) => s.status === 'stopped')
      expect(stopped.stoppedReason).toBe('breakpoint')
      const threadId = stopped.threadId ?? (await session.threads())[0].id
      const [top] = (await session.stackTrace(threadId)).stackFrames
      expect(top.line).toBe(bpLine)

      const scopes = await session.scopes(top.id)
      const locals = scopes.find((scope) => scope.name.toLowerCase() === 'locals')
      expect(locals, JSON.stringify(scopes)).toBeDefined()
      const variables = await session.variables(locals?.variablesReference ?? 0)
      expect(variables.find((v) => v.name === 'a')?.value).toBe('2')
      expect((await session.evaluate('a + b', top.id)).result).toBe('5')

      await session.next(threadId)
      await waitFor(session, (s) => s.status === 'stopped')
      expect((await session.stackTrace(threadId)).stackFrames[0].line).toBe(bpLine + 1)

      await session.continue(threadId)
      await waitFor(session, (s) => s.status === 'terminated')
      // Measured: on linux debugpy does not forward the program's own print.
      if (process.platform === 'darwin') {
        const printed = session
          .output()
          .map((entry) => entry.output)
          .join('')
        expect(printed).toContain('LIVE-DEBUG-TARGET printed 5')
      }
    },
    LIVE_TIMEOUT_MS
  )
})

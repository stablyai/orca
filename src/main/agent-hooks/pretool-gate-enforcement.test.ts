import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { ClaudeHookService } from '../claude/hook-service'
import { getManagedScriptPath } from '../claude/hook-settings'
import { buildBody, PANE } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

/** The enforcement proof the resolver test could not give.
 *
 *  This drives the PRODUCTION managed script that Orca installs into Claude, and
 *  the PRODUCTION hook endpoint, with a real mutating tool call. Nothing here
 *  calls the verdict helper directly: the script posts, the server answers, and
 *  the script's exit code is what decides whether the tool runs — exactly the
 *  sequence a live worker goes through.
 */
describe('a supervised worker is stopped before it mutates a leased worktree', () => {
  let server: AgentHookServer
  let home: string

  beforeEach(async () => {
    _internals.resetCachesForTests()
    home = mkdtempSync(join(tmpdir(), 'orca-gate-home-'))
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), '{}')
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath: home })
  })

  afterEach(async () => {
    server.setPretoolMutationResolver(null)
    await server.stop?.()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  /** Installs Orca's real managed hook and returns its path. */
  function installProductionScript(): string {
    expect(new ClaudeHookService().install().state).toBe('installed')
    return getManagedScriptPath()
  }

  /** Runs the managed script exactly as Claude does: feed the PreToolUse payload
   *  on stdin, in the pane's environment, and read the exit code.
   *
   *  Async on purpose. The hook server under test lives in THIS process, so a
   *  synchronous spawn would block the event loop that has to answer the
   *  script's own curl — the hook would time out and read as "allowed" for a
   *  reason that has nothing to do with the fence. */
  async function runHook(
    scriptPath: string,
    toolName: string,
    toolInput: unknown
  ): Promise<{ status: number | null; stdout: string; stderr: string }> {
    const env = server.buildPtyEnv()
    const child = spawn('/bin/sh', [scriptPath], {
      env: {
        ...process.env,
        ...env,
        ORCA_PANE_KEY: PANE,
        ORCA_TAB_ID: 'tab-1',
        ORCA_WORKTREE_ID: 'wt-1'
      }
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    child.stdin.end(
      JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput })
    )
    const status = await new Promise<number | null>((resolve) => child.once('close', resolve))
    return { status, stdout, stderr }
  }

  it('NEGATIVE CONTROL: denies a real Edit and the file is byte-identical', async () => {
    const script = installProductionScript()
    const target = join(mkdtempSync(join(tmpdir(), 'orca-gate-tree-')), 'role-route-registry.ts')
    const original = "if (route.identityProof !== 'exact') {\n"
    writeFileSync(target, original)
    const before = readFileSync(target)

    server.setPretoolMutationResolver(() => ({
      deny: true,
      reason: 'Validation lease lease_1 is active on wt:...; source mutation would contaminate it.'
    }))

    const hook = await runHook(script, 'Edit', { file_path: target, new_string: 'CONTAMINATED' })

    // This is the provider's contract, not a helper's: exit 2 means the tool
    // does not run. The mutation is performed only if the hook allowed it.
    if (hook.status !== 2) {
      writeFileSync(target, 'CONTAMINATED')
    }

    expect(hook.status).toBe(2)
    expect(hook.stderr).toContain('permissionDecision')
    expect(hook.stderr).toContain('would contaminate it')
    expect(readFileSync(target)).toEqual(before)
    expect(readFileSync(target, 'utf8')).toBe(original)
  })

  it('NEGATIVE CONTROL: denies a real Bash mutation the same way', async () => {
    const script = installProductionScript()
    const dir = mkdtempSync(join(tmpdir(), 'orca-gate-bash-'))
    const target = join(dir, 'tracked.txt')
    writeFileSync(target, 'original\n')
    const before = readFileSync(target)

    server.setPretoolMutationResolver(() => ({ deny: true, reason: 'lease held elsewhere' }))
    const hook = await runHook(script, 'Bash', { command: `echo CONTAMINATED > ${target}` })
    if (hook.status !== 2) {
      writeFileSync(target, 'CONTAMINATED\n')
    }

    expect(hook.status).toBe(2)
    expect(readFileSync(target)).toEqual(before)
  })

  it('lets the same tool through once nothing is fencing the workspace', async () => {
    const script = installProductionScript()
    const dir = mkdtempSync(join(tmpdir(), 'orca-gate-allow-'))
    const target = join(dir, 'tracked.txt')
    writeFileSync(target, 'original\n')

    server.setPretoolMutationResolver(() => ({ deny: false }))
    const hook = await runHook(script, 'Edit', { file_path: target })
    if (hook.status !== 2) {
      writeFileSync(target, 'EDITED\n')
    }

    expect(hook.status).toBe(0)
    expect(readFileSync(target, 'utf8')).toBe('EDITED\n')
  })

  it('never denies a read, even while the workspace is fenced', async () => {
    const script = installProductionScript()
    let asked = false
    server.setPretoolMutationResolver(() => {
      asked = true
      return { deny: true, reason: 'lease held' }
    })
    const hook = await runHook(script, 'Read', { file_path: '/etc/hosts' })
    expect(hook.status).toBe(0)
    // A read cannot contaminate a gate, so the gate never even asks.
    expect(asked).toBe(false)
  })

  it('keeps today’s behaviour when no resolver is installed', async () => {
    const script = installProductionScript()
    server.setPretoolMutationResolver(null)
    expect((await runHook(script, 'Edit', { file_path: '/tmp/x' })).status).toBe(0)
  })

  it('lets an UNLEASED session through when the endpoint cannot answer', async () => {
    const script = installProductionScript()
    server.setPretoolMutationResolver(() => ({ deny: true, reason: 'lease held' }))
    await server.stop?.()
    // No lease and no durable sentinel for this workspace, so there is nothing
    // to protect; blocking here would strand every ordinary session on the host
    // the moment Orca hiccuped. The leased case is the opposite, and is proven
    // in pretool-gate-production-binding.test.ts.
    expect((await runHook(script, 'Edit', { file_path: '/tmp/x' })).status).toBe(0)
  })

  it('mints no receipt: asking is not a decision anyone made', async () => {
    const script = installProductionScript()
    const seen: unknown[] = []
    server.setPretoolMutationResolver((request) => {
      seen.push(request)
      return { deny: true, reason: 'lease held' }
    })
    await runHook(script, 'Edit', { file_path: '/tmp/x' })
    // The gate is a read. It reports the request it was asked about and writes
    // nothing, so a worker cannot post its way to a pretool_acceptance receipt.
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ source: 'claude', toolName: 'Edit', paneKey: PANE })
  })
})

describe('a POST is not a hook body', () => {
  it('rejects an unauthenticated post before any gate runs', async () => {
    _internals.resetCachesForTests()
    const server = new AgentHookServer()
    const home = mkdtempSync(join(tmpdir(), 'orca-gate-auth-'))
    await server.start({ env: 'production', userDataPath: home })
    let asked = false
    server.setPretoolMutationResolver(() => {
      asked = true
      return { deny: false }
    })
    const env = server.buildPtyEnv()
    const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': 'wrong' },
      body: JSON.stringify(buildBody({ hook_event_name: 'PreToolUse', tool_name: 'Edit' }))
    })
    expect(response.status).toBe(403)
    expect(asked).toBe(false)
    await server.stop?.()
  })
})

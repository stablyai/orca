import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { MachineProviderError } from '../../shared/machine-provider-protocol'
import {
  resolveMachineProviderInvocation,
  runMachineProviderVerb,
  type RunMachineProviderVerbArgs
} from './machine-provider-process'

const FIXTURES = join(__dirname, '__fixtures__')
const FAKE = {
  command: ['$orca-node', '$plugin/fake-machine-provider.mjs'],
  pluginRootDir: FIXTURES
}
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-machine-provider-'))
  roots.push(root)
  return root
}

function fakeArgs(
  overrides: Partial<RunMachineProviderVerbArgs> & { mode?: string } = {}
): RunMachineProviderVerbArgs {
  const { mode, ...rest } = overrides
  return {
    source: FAKE,
    verb: 'list',
    operationId: 'op-1',
    cwd: tmpdir(),
    env: { ...process.env, FAKE_MACHINE_PROVIDER_MODE: mode ?? '' },
    ...rest
  }
}

function stubRun(
  result: Partial<ProcessResult>
): Mock<(spec: ProcessSpec) => Promise<ProcessResult>> {
  return vi.fn(async (_spec: ProcessSpec): Promise<ProcessResult> => ({
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...result
  }))
}

async function rejection(promise: Promise<unknown>): Promise<MachineProviderError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  if (!(error instanceof MachineProviderError)) {
    throw new Error(`expected a MachineProviderError, got ${String(error)}`)
  }
  return error
}

describe('runMachineProviderVerb', () => {
  it('runs a plugin script under Orca node with the request on stdin', async () => {
    const statePath = join(await tempDir(), 'state.json')
    const env = { ...process.env, FAKE_MACHINE_PROVIDER_STATE: statePath }
    const created = await runMachineProviderVerb(
      fakeArgs({
        verb: 'create',
        operationId: 'op-create',
        contextId: 'fake:tester',
        params: { name: 'dev', lifetime: 'temporary' },
        env
      })
    )
    expect(created).toMatchObject({
      kind: 'machine',
      machine: { id: 'm-1', name: 'dev', lifetime: 'temporary', state: 'running' }
    })

    const listed = await runMachineProviderVerb(fakeArgs({ operationId: 'op-list', env }))
    expect(listed).toMatchObject({ kind: 'inventory', machines: [{ id: 'm-1' }] })
  })

  it('classifies a rejected ssh login as auth-required without waiting for a timeout', async () => {
    const startedAt = Date.now()
    const error = await rejection(runMachineProviderVerb(fakeArgs({ mode: 'auth' })))
    expect(error.code).toBe('auth-required')
    expect(error.message).toContain('Permission denied')
    expect(Date.now() - startedAt).toBeLessThan(10_000)
  })

  it('rejects non-JSON output as an invalid response', async () => {
    const error = await rejection(runMachineProviderVerb(fakeArgs({ mode: 'garbage' })))
    expect(error.code).toBe('invalid-response')
  })

  it('surfaces a structured provider error from a failing exit', async () => {
    const error = await rejection(
      runMachineProviderVerb(fakeArgs({ verb: 'get', machineId: 'missing' }))
    )
    expect(error.code).toBe('not-found')
  })

  it('keeps a wrong-account error from a failing exit as a context mismatch', async () => {
    const error = await rejection(
      runMachineProviderVerb(
        fakeArgs({ verb: 'get', machineId: 'missing', contextId: 'fake:someone-else' })
      )
    )
    expect(error.code).toBe('context-mismatch')
  })

  it('reports a cancelled run as cancelled', async () => {
    const controller = new AbortController()
    const pending = runMachineProviderVerb(fakeArgs({ mode: 'hang', signal: controller.signal }))
    setTimeout(() => controller.abort(), 200)
    expect((await rejection(pending)).code).toBe('cancelled')
  })

  it('bounds reads at 20s as unavailable and leaves mutation timeouts unresolved', async () => {
    const run = stubRun({ timedOut: true })
    const read = await rejection(runMachineProviderVerb(fakeArgs({ run })))
    expect(read.code).toBe('unavailable')
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      timeoutMs: 20_000,
      maxOutputBytes: 512 * 1024,
      killOnOutputLimit: true
    })

    const mutation = await rejection(runMachineProviderVerb(fakeArgs({ verb: 'create', run })))
    expect(mutation.code).toBe('timeout')
    expect(run.mock.calls[1]?.[0]).toMatchObject({ timeoutMs: 15 * 60_000 })
  })

  it('rejects truncated output', async () => {
    const run = stubRun({ outputTruncated: true, stdout: '{' })
    expect((await rejection(runMachineProviderVerb(fakeArgs({ run })))).code).toBe(
      'invalid-response'
    )
  })

  it('never spawns for a machine id that could inject into the remote shell line', async () => {
    const run = stubRun({})
    // Proven live: ssh re-joins argv, so this id would run `touch` on the provider host.
    for (const machineId of [
      'x;touch /tmp/pwn',
      'a;touch x',
      '$(id)',
      '-oProxyCommand=x',
      'a b',
      ''
    ]) {
      await expect(
        runMachineProviderVerb(fakeArgs({ verb: 'wake', machineId, run }))
      ).rejects.toThrow('Invalid machine id')
    }
    expect(run).not.toHaveBeenCalled()
  })

  it('sends verb and id as argv and everything else as one stdin document', async () => {
    const run = stubRun({})
    await runMachineProviderVerb(
      fakeArgs({
        source: { command: ['ssh', 'omarchy', 'orca-sandbox'], pluginRootDir: FIXTURES },
        verb: 'sleep',
        machineId: 'sbx-1',
        contextId: 'omarchy:neil',
        cwd: '/user-data',
        run
      })
    ).catch(() => undefined)
    const spec = run.mock.calls[0]?.[0]
    expect(spec).toMatchObject({
      program: 'ssh',
      args: ['omarchy', 'orca-sandbox', 'sleep', '--json', '--id', 'sbx-1'],
      cwd: '/user-data',
      timeoutMs: 180_000
    })
    expect(JSON.parse(spec?.input ?? '')).toEqual({
      protocolVersion: 1,
      operationId: 'op-1',
      verb: 'sleep',
      contextId: 'omarchy:neil',
      machineId: 'sbx-1'
    })
  })
})

describe('resolveMachineProviderInvocation', () => {
  it('resolves $orca-node and $plugin paths and disables hidden ssh prompts', async () => {
    const invocation = await resolveMachineProviderInvocation(
      FIXTURES,
      [...FAKE.command, 'list', '--json'],
      { execPath: '/Applications/Orca.app/Orca', env: { DISPLAY: ':0', PATH: '/bin' } }
    )
    expect(invocation.program).toBe('/Applications/Orca.app/Orca')
    expect(invocation.args).toEqual([join(FIXTURES, 'fake-machine-provider.mjs'), 'list', '--json'])
    expect(invocation.env).toEqual({
      PATH: '/bin',
      SSH_ASKPASS_REQUIRE: 'never',
      ELECTRON_RUN_AS_NODE: '1'
    })
  })

  it('does not mark other programs as Electron-as-node', async () => {
    const invocation = await resolveMachineProviderInvocation(FIXTURES, ['ssh', 'list', '--json'], {
      execPath: '/x',
      env: {}
    })
    expect(invocation).toEqual({
      program: 'ssh',
      args: ['list', '--json'],
      env: { SSH_ASKPASS_REQUIRE: 'never' }
    })
  })

  it('passes a plugin .cmd shim to process-host as a resolved program path', async () => {
    const root = await tempDir()
    await mkdir(join(root, 'bin'))
    await writeFile(join(root, 'bin', 'provider.cmd'), '@echo off\r\n')
    const invocation = await resolveMachineProviderInvocation(
      root,
      ['$plugin/bin/provider.cmd', 'list', '--json'],
      { execPath: '/x', env: {} }
    )
    // process-host routes a .cmd program through cmd.exe with verbatim, escaped arguments.
    expect(invocation.program).toMatch(/provider\.cmd$/)
  })

  it('refuses a $plugin path that escapes the plugin root through a symlink', async () => {
    const root = await tempDir()
    const outside = await tempDir()
    await writeFile(join(outside, 'evil.sh'), '')
    await symlink(join(outside, 'evil.sh'), join(root, 'provider.sh'))
    await expect(
      resolveMachineProviderInvocation(root, ['$plugin/provider.sh', 'list', '--json'], {
        execPath: '/x',
        env: {}
      })
    ).rejects.toThrow('outside the plugin directory')
  })
})

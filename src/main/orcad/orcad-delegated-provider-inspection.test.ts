import { afterEach, expect, it, vi } from 'vitest'
import { OrcadDelegatedProviderInspection } from './orcad-delegated-provider-inspection'
import { identity } from '../../relay/relay-pty-ownership-transfer-delegation-test-fixture'
afterEach(() => vi.restoreAllMocks())

function setup(terminalHandle?: string) {
  const input = {
    runControl: vi.fn(async <T>(_id: string, operation: () => Promise<T>) => operation())
  }
  const operations = {
    inspectProcess: vi.fn(),
    inspectCwd: vi.fn(async (): Promise<string | null> => '/current'),
    inspectTerminalInfo: vi.fn(async () => ({
      pid: 42,
      cols: 103,
      rows: 37,
      initialCwd: '/initial',
      ...(terminalHandle ? { terminalHandle } : {})
    }))
  }
  return {
    input,
    operations,
    inspection: new OrcadDelegatedProviderInspection({
      identity,
      workspaceKey: 'folder:folder-1',
      input: {
        runControl: async <T>(id: string, operation: () => Promise<T>) =>
          (await input.runControl(id, operation)) as T
      },
      operations
    })
  }
}

it('publishes the source-recorded handle for exact worker recovery', async () => {
  const f = setup('term_original')
  expect(await f.inspection.listProcesses()).toMatchObject([
    {
      id: identity.terminalId,
      incarnationId: identity.incarnationId,
      terminalHandle: 'term_original'
    }
  ])
})

it('routes all inspections through the provider ordering lane', async () => {
  const f = setup()
  await expect(f.inspection.getCwd('pty')).resolves.toBe('/current')
  await expect(f.inspection.getInitialCwd('pty')).resolves.toBe('/initial')
  await expect(f.inspection.getAppliedSize('pty')).resolves.toEqual({ cols: 103, rows: 37 })
  expect(f.input.runControl).toHaveBeenCalledTimes(3)
  expect(f.input.runControl).toHaveBeenCalledWith('pty', expect.any(Function))
})

it('never substitutes initial cwd for an unavailable current cwd', async () => {
  const f = setup()
  f.operations.inspectCwd.mockResolvedValue(null)
  await expect(f.inspection.getCwd('pty')).rejects.toThrow('cwd_unverifiable')
  expect(f.operations.inspectTerminalInfo).not.toHaveBeenCalled()
})

it('preserves unavailable size and refuses unavailable initial cwd', async () => {
  const f = setup()
  f.operations.inspectTerminalInfo.mockResolvedValue(null as never)
  await expect(f.inspection.getAppliedSize('pty')).resolves.toBeNull()
  await expect(f.inspection.getInitialCwd('pty')).rejects.toThrow('initial_cwd_unverifiable')
})

it('cannot bypass a disconnected or wrong-terminal lane', async () => {
  const f = setup()
  f.input.runControl.mockRejectedValue(new Error('route unavailable'))
  await expect(f.inspection.getCwd('wrong')).rejects.toThrow('route unavailable')
  await expect(f.inspection.getInitialCwd('wrong')).rejects.toThrow('route unavailable')
  await expect(f.inspection.getAppliedSize('wrong')).rejects.toThrow('route unavailable')
  expect(f.operations.inspectCwd).not.toHaveBeenCalled()
  expect(f.operations.inspectTerminalInfo).not.toHaveBeenCalled()
})

it('does not turn unavailable foreground evidence into an idle process name', async () => {
  const f = setup()
  f.operations.inspectProcess.mockResolvedValue({
    foregroundProcessEvidence: { verdict: 'unverifiable', reason: 'host_unavailable' }
  })
  await expect(f.inspection.getForegroundProcess('pty')).rejects.toThrow('foreground_unverifiable')
  expect(f.input.runControl).toHaveBeenCalledWith('pty', expect.any(Function))
})

it('uses the host-evidenced foreground name instead of a compatibility fallback', async () => {
  const f = setup()
  f.operations.inspectProcess.mockResolvedValue({
    foregroundProcess: 'fallback',
    foregroundProcessEvidence: { verdict: 'live', processName: 'bash' }
  })
  await expect(f.inspection.getForegroundProcess('pty')).resolves.toBe('bash')
})

it.each([
  ['children', true],
  ['no-children', false]
] as const)('maps exact %s evidence to the provider boolean', async (evidence, result) => {
  const f = setup()
  f.operations.inspectProcess.mockResolvedValue({ childProcessEvidence: evidence })
  await expect(f.inspection.hasChildProcesses('pty')).resolves.toBe(result)
})

it.each(['unverifiable', undefined])(
  'refuses %s child evidence instead of reporting idle',
  async (evidence) => {
    const f = setup()
    f.operations.inspectProcess.mockResolvedValue({ childProcessEvidence: evidence })
    await expect(f.inspection.hasChildProcesses('pty')).rejects.toThrow('children_unverifiable')
  }
)

it('returns only the bound terminal with a fresh host PID and current cwd', async () => {
  const f = setup()
  await expect(f.inspection.listProcesses()).resolves.toEqual([
    {
      id: identity.terminalId,
      incarnationId: identity.incarnationId,
      rootProcessId: 42,
      cwd: '/current',
      title: '',
      worktreeId: 'folder:folder-1'
    }
  ])
  expect(f.operations.inspectProcess).not.toHaveBeenCalled()
  expect(f.input.runControl).toHaveBeenCalledOnce()
})

it('retains unverifiable foreground evidence on an otherwise host-confirmed terminal', async () => {
  const f = setup()
  const evidence = { verdict: 'unverifiable', reason: 'host_unavailable' }
  f.operations.inspectProcess.mockResolvedValue({ foregroundProcessEvidence: evidence })
  await expect(
    f.inspection.listProcesses({ includeForegroundProcessEvidence: true })
  ).resolves.toMatchObject([{ foregroundProcessEvidence: evidence, rootProcessId: 42 }])
})

it.each(['cwd', 'terminal'])(
  'refuses unavailable %s inventory instead of returning an empty list',
  async (mode) => {
    const f = setup()
    if (mode === 'cwd') {
      f.operations.inspectCwd.mockResolvedValue(null)
    } else {
      f.operations.inspectTerminalInfo.mockResolvedValue(null as never)
    }
    await expect(f.inspection.listProcesses()).rejects.toThrow('inventory_unverifiable')
  }
)

it('passes the remaining deadline to each host request and rejects a late reply', async () => {
  const f = setup()
  let now = 100
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  f.operations.inspectCwd.mockImplementation(async () => {
    now = 120
    return '/current'
  })
  f.operations.inspectProcess.mockImplementation(async () => {
    now = 150
    return { foregroundProcessEvidence: { verdict: 'unverifiable' } }
  })
  await f.inspection.listProcesses({ deadlineMs: 200, includeForegroundProcessEvidence: true })
  expect(f.operations.inspectCwd).toHaveBeenCalledWith(identity.terminalId, 100)
  expect(f.operations.inspectProcess).toHaveBeenCalledWith(identity.terminalId, 80)
  expect(f.operations.inspectTerminalInfo).toHaveBeenCalledWith(identity.terminalId, 50)
  f.operations.inspectTerminalInfo.mockImplementation(async () => {
    now = 200
    return { pid: 42, cols: 80, rows: 24, initialCwd: '/initial' }
  })
  await expect(f.inspection.listProcesses({ deadlineMs: 200 })).rejects.toThrow('deadline_expired')
})

it('checks deadline after waiting behind input before making any RPC', async () => {
  const f = setup()
  vi.spyOn(Date, 'now').mockReturnValue(200)
  await expect(f.inspection.listProcesses({ deadlineMs: 100 })).rejects.toThrow('deadline_expired')
  expect(f.operations.inspectCwd).not.toHaveBeenCalled()
  expect(f.operations.inspectTerminalInfo).not.toHaveBeenCalled()
})

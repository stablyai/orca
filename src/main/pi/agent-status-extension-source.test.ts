import { describe, expect, it, vi } from 'vitest'

import {
  AGENT_STATUS_EXTENSION_SELF_PID as SELF_PID,
  createAgentStatusExtensionHarness as createHarness
} from './agent-status-extension-test-harness'

describe('getPiAgentStatusExtensionSource', () => {
  it('registers Prime hooks only in the event-emitting daemon worker', () => {
    const frontend = createHarness({
      kind: 'prime-agent',
      env: { PRIME_AGENT_INTERNAL_DAEMON_WORKER: undefined }
    })
    const worker = createHarness({
      kind: 'prime-agent',
      env: { ORCA_PI_STATUS_OWNED: String(SELF_PID - 1) }
    })

    expect(frontend.handlers).toEqual({})
    expect(frontend.processEnv.ORCA_PI_STATUS_OWNED).toBeUndefined()
    expect(worker.handlers.agent_start).toBeTypeOf('function')
    expect(worker.processEnv.ORCA_PRIME_AGENT_STATUS_OWNED).toBe(String(SELF_PID))
  })

  it('posts persisted Prime session metadata to the Prime route', async () => {
    const harness = createHarness({
      kind: 'prime-agent',
      existsSync: (path) => path === '/tmp/prime-session-1.jsonl'
    })

    await harness.callHook(
      'session_start',
      { reason: 'startup' },
      {
        sessionManager: {
          getSessionId: () => 'prime-session-1',
          getSessionFile: () => '/tmp/prime-session-1.jsonl'
        }
      }
    )

    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    expect(harness.fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:4321/hook/prime-agent')
    expect(JSON.parse(String(harness.fetchMock.mock.calls[0]?.[1]?.body)).payload).toEqual({
      hook_event_name: 'session_start',
      session_id: 'prime-session-1',
      session_file: '/tmp/prime-session-1.jsonl'
    })
  })

  it('includes the session id and file path in Pi status posts after session_start', async () => {
    const harness = createHarness({
      kind: 'pi',
      existsSync: (path) => path === '/tmp/pi-session-1.jsonl'
    })

    await harness.callHook(
      'session_start',
      {},
      {
        sessionManager: {
          getSessionId: () => 'pi-session-1',
          getSessionFile: () => '/tmp/pi-session-1.jsonl'
        }
      }
    )

    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(harness.fetchMock.mock.calls[0]?.[1]?.body)).payload).toEqual({
      hook_event_name: 'session_start',
      session_id: 'pi-session-1',
      session_file: '/tmp/pi-session-1.jsonl'
    })

    await harness.callHook('before_agent_start', { prompt: 'resume this task' })

    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(2))
    const body = JSON.parse(String(harness.fetchMock.mock.calls[1]?.[1]?.body))
    expect(body.payload).toEqual({
      hook_event_name: 'before_agent_start',
      prompt: 'resume this task',
      session_id: 'pi-session-1',
      session_file: '/tmp/pi-session-1.jsonl'
    })
  })

  it('waits until Pi creates its planned session file before advertising resume identity', async () => {
    let sessionFileExists = false
    const harness = createHarness({
      kind: 'pi',
      existsSync: (path) => path === '/tmp/pi-session-1.jsonl' && sessionFileExists
    })

    await harness.callHook(
      'session_start',
      { reason: 'startup' },
      {
        sessionManager: {
          getSessionId: () => 'pi-session-1',
          getSessionFile: () => '/tmp/pi-session-1.jsonl'
        }
      }
    )

    expect(JSON.parse(String(harness.fetchMock.mock.calls[0]?.[1]?.body)).payload).toEqual({
      hook_event_name: 'session_start'
    })

    sessionFileExists = true
    await harness.callHook('agent_end')

    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(2))
    expect(JSON.parse(String(harness.fetchMock.mock.calls[1]?.[1]?.body)).payload).toEqual({
      hook_event_name: 'agent_end',
      session_id: 'pi-session-1',
      session_file: '/tmp/pi-session-1.jsonl'
    })
  })

  it('refreshes Pi session metadata on reload without posting a replacement status', async () => {
    const harness = createHarness({
      kind: 'pi',
      existsSync: (path) => path === '/tmp/pi-reloaded.jsonl'
    })

    await harness.callHook(
      'session_start',
      { reason: 'reload' },
      {
        sessionManager: {
          getSessionId: () => 'pi-reloaded',
          getSessionFile: () => '/tmp/pi-reloaded.jsonl'
        }
      }
    )
    expect(harness.fetchMock).not.toHaveBeenCalled()

    await harness.callHook('agent_start')
    expect(JSON.parse(String(harness.fetchMock.mock.calls[0]?.[1]?.body)).payload).toEqual({
      hook_event_name: 'agent_start',
      session_id: 'pi-reloaded',
      session_file: '/tmp/pi-reloaded.jsonl'
    })
  })

  it('omits absent or empty Pi session metadata from status posts', async () => {
    for (const sessionManager of [
      { getSessionId: () => '', getSessionFile: () => undefined },
      { getSessionFile: () => '/tmp/pi-session.jsonl' }
    ]) {
      const harness = createHarness({ kind: 'pi' })
      await harness.callHook('session_start', {}, { sessionManager })
      await harness.callHook('agent_start')

      await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(2))
      const payloads = harness.fetchMock.mock.calls.map(
        ([_event, init]) => JSON.parse(String(init?.body)).payload
      )
      expect(payloads).toEqual([
        { hook_event_name: 'session_start' },
        { hook_event_name: 'agent_start' }
      ])
    }
  })

  it('keeps OMP runtime status payloads unchanged by Pi session metadata', async () => {
    const harness = createHarness({ kind: 'omp' })

    await harness.callHook(
      'session_start',
      {},
      {
        sessionManager: {
          getSessionId: () => 'omp-session-1',
          getSessionFile: () => '/tmp/omp-session-1.jsonl'
        }
      }
    )
    await harness.callHook('agent_start')

    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    expect(harness.fetchMock.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        paneKey: 'pane-1',
        launchToken: 'launch-1',
        tabId: 'tab-1',
        worktreeId: 'tree-1',
        env: 'env-1',
        version: '1.2.3',
        payload: { hook_event_name: 'agent_start' }
      })
    )
  })

  it('tracks persistent OMP sessions and clears ephemeral session ids', async () => {
    const harness = createHarness({ kind: 'omp' })
    let sessionId = 'omp-session-8'
    const sessionManager = { getSessionId: () => sessionId, getSessionFile: () => '/tmp/s' }

    await harness.callHook('agent_start', undefined, { sessionManager })
    sessionId = 'omp-session-9'
    await harness.callHook('before_agent_start', { prompt: 'hi' }, { sessionManager })
    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(2))
    await harness.callHook('agent_end', undefined, {
      sessionManager: { getSessionId: () => 'omp-ephemeral' }
    })

    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(3))
    expect(
      harness.fetchMock.mock.calls.map(([_event, init]) => JSON.parse(String(init?.body)).payload)
    ).toEqual([
      { hook_event_name: 'agent_start', session_id: 'omp-session-8' },
      {
        hook_event_name: 'before_agent_start',
        prompt: 'hi',
        session_id: 'omp-session-9'
      },
      { hook_event_name: 'agent_end' }
    ])
  })

  it.each([
    ['OMP extension', { kind: 'omp' as const }],
    ['runtime-routed OMP', { kind: 'pi' as const, title: 'omp' }]
  ])(
    'keeps queued %s status bound to the session active when it was posted',
    async (_name, args) => {
      const finishDeliveries: (() => void)[] = []
      const harness = createHarness({
        ...args,
        fetchImpl: vi.fn(
          () =>
            new Promise((resolve) => {
              finishDeliveries.push(() => resolve({ ok: true }))
            })
        )
      })

      await harness.callHook('agent_start', undefined, {
        sessionManager: {
          getSessionId: () => 'omp-session-8',
          getSessionFile: () => '/tmp/omp-session-8.jsonl'
        }
      })
      await harness.callHook(
        'message_end',
        { message: { role: 'assistant', content: 'done' } },
        {
          sessionManager: {
            getSessionId: () => 'omp-session-9',
            getSessionFile: () => '/tmp/omp-session-9.jsonl'
          }
        }
      )
      await harness.callHook('message_end', { message: { role: 'user', content: 'next' } }, {})

      finishDeliveries[0]?.()
      await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(2))
      const body = JSON.parse(String(harness.fetchMock.mock.calls[1]?.[1]?.body))
      expect(body.payload).toEqual({
        hook_event_name: 'message_end',
        role: 'assistant',
        text: 'done',
        session_id: 'omp-session-9'
      })
      expect(body.payload).not.toHaveProperty('session_file')
      expect(harness.fetchMock.mock.calls[1]?.[0]).toBe('http://127.0.0.1:4321/hook/omp')
      expect(harness.spawnMock).not.toHaveBeenCalled()
      finishDeliveries[1]?.()
    }
  )

  it.each(['pi', 'omp', 'prime-agent'] as const)(
    'registers no status handlers for a nested %s subagent process',
    (kind) => {
      // Why: inheriting the lead's owner PID must disable the extension as a
      // whole, so future hook additions cannot reopen the notification leak.
      const lead = createHarness({ kind, pid: SELF_PID })
      const child = createHarness({ kind, pid: SELF_PID + 1, env: lead.processEnv })
      const grandchild = createHarness({ kind, pid: SELF_PID + 2, env: child.processEnv })

      expect(child.handlers).toEqual({})
      expect(grandchild.handlers).toEqual({})
      const ownerKey =
        kind === 'prime-agent' ? 'ORCA_PRIME_AGENT_STATUS_OWNED' : 'ORCA_PI_STATUS_OWNED'
      expect(child.processEnv[ownerKey]).toBe(String(SELF_PID))
      expect(grandchild.processEnv[ownerKey]).toBe(String(SELF_PID))
      expect(child.fetchMock).not.toHaveBeenCalled()
      expect(child.spawnMock).not.toHaveBeenCalled()
    }
  )

  it('reports agent_end for a top-level run (including non-interactive) and claims the pane by pid', async () => {
    // Why: non-interactive top-level runs still own their pane and must report.
    const harness = createHarness({ kind: 'pi', pid: SELF_PID, argv: ['node', 'pi', '-p'] })

    await harness.callHook('agent_end')

    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String(harness.fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.payload).toEqual({ hook_event_name: 'agent_end' })
    expect(harness.processEnv.ORCA_PI_STATUS_OWNED).toBe(String(SELF_PID))
  })

  it('keeps reporting after the lead re-runs the extension factory on reload', async () => {
    // Why: Pi reloads extensions in-process, so the lead must recognize its PID
    // instead of mistaking its own marker for a nested child.
    const harness = createHarness({ kind: 'pi', pid: SELF_PID })

    expect(harness.processEnv.ORCA_PI_STATUS_OWNED).toBe(String(SELF_PID))

    harness.reload()
    await harness.callHook('agent_end')

    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(String(harness.fetchMock.mock.calls[0]?.[1]?.body))
    expect(body.payload).toEqual({ hook_event_name: 'agent_end' })
  })

  it('keeps native fetch as the only path even when the runtime looks like WSL', async () => {
    const harness = createHarness({
      kind: 'omp',
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      existsSync: () => true
    })

    await harness.callHook('agent_start')

    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    expect(harness.spawnMock).not.toHaveBeenCalled()
  })

  it('falls back to Windows curl from WSL when fetch fails', async () => {
    const harness = createHarness({
      kind: 'omp',
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      existsSync: (path) => path === '/mnt/c/Windows/System32/curl.exe',
      fetchImpl: vi.fn(async () => {
        throw new Error('loopback unreachable')
      })
    })

    await harness.callHook('agent_start')

    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(harness.spawnMock).toHaveBeenCalledTimes(1))

    const [command, args, options] = harness.spawnMock.mock.calls[0] ?? []
    expect(command).toBe('/mnt/c/Windows/System32/curl.exe')
    expect(args).toEqual([
      '-sS',
      '--connect-timeout',
      '3',
      '--max-time',
      '10',
      '--noproxy',
      '127.0.0.1',
      '-o',
      'NUL',
      '-X',
      'POST',
      '-H',
      'Content-Type: application/json',
      '-H',
      'X-Orca-Agent-Hook-Token: token-1',
      '--data-binary',
      '@-',
      'http://127.0.0.1:4321/hook/omp'
    ])
    // Why: delivery must be fire-and-forget off the pi event loop — no
    // blocking wait — with the payload fed via stdin, never argv.
    expect(options).toEqual({ stdio: ['pipe', 'ignore', 'ignore'] })
    const child = harness.spawnedChildren[0]
    expect(child?.on).toHaveBeenCalledWith('error', expect.any(Function))
    expect(child?.stdin.on).toHaveBeenCalledWith('error', expect.any(Function))
    expect(child?.stdin.end).toHaveBeenCalledWith(
      JSON.stringify({
        paneKey: 'pane-1',
        launchToken: 'launch-1',
        tabId: 'tab-1',
        worktreeId: 'tree-1',
        env: 'env-1',
        version: '1.2.3',
        payload: { hook_event_name: 'agent_start' }
      })
    )
  })

  it('uses current Windows coordinates when a same-token guest endpoint is stale', async () => {
    const endpointPath = '/home/u/.orca-wsl/agent-hooks/instance-test/endpoint.env'
    const harness = createHarness({
      kind: 'prime-agent',
      env: { WSL_DISTRO_NAME: 'Ubuntu', ORCA_AGENT_HOOK_ENDPOINT: endpointPath },
      existsSync: (path) => path === '/mnt/c/Windows/System32/curl.exe',
      statSync: () => ({ mtimeMs: 1, size: 80, ino: 1 }),
      readFileSync: (path) => {
        if (path === endpointPath) {
          return 'ORCA_AGENT_HOOK_PORT=9999\nORCA_AGENT_HOOK_TOKEN=token-1\n'
        }
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      },
      fetchImpl: vi.fn(async () => {
        throw new Error('stale guest relay')
      })
    })

    await harness.callHook('agent_start')

    expect(harness.fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:9999/hook/prime-agent')
    await vi.waitFor(() => expect(harness.spawnMock).toHaveBeenCalledTimes(1))
    expect(harness.spawnMock.mock.calls[0]?.[1]).toContain('http://127.0.0.1:4321/hook/prime-agent')
  })

  it('probes WSL evidence and the curl path once per process', async () => {
    const harness = createHarness({
      kind: 'omp',
      existsSync: (path) => path === '/mnt/c/Windows/System32/curl.exe',
      readFileSync: (path) => {
        if (path === '/proc/sys/kernel/osrelease') {
          return 'microsoft-standard-WSL2'
        }
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      },
      fetchImpl: vi.fn(async () => {
        throw new Error('loopback unreachable')
      })
    })

    await harness.callHook('agent_start')
    await harness.callHook('agent_end')

    await vi.waitFor(() => expect(harness.spawnMock).toHaveBeenCalledTimes(2))
    // Why: WSL-ness and curl.exe presence are process-lifetime constants;
    // the per-event failure path must not re-probe /proc or /mnt/c.
    const procReads = harness.fsMock.readFileSync.mock.calls.filter(([path]) =>
      String(path).startsWith('/proc/')
    )
    expect(procReads).toHaveLength(1)
    expect(harness.fsMock.existsSync).toHaveBeenCalledTimes(1)
  })

  it('stays fail-open on ordinary Linux', async () => {
    const harness = createHarness({
      kind: 'omp',
      existsSync: () => true,
      fetchImpl: vi.fn(async () => {
        throw new Error('loopback unreachable')
      })
    })

    await harness.callHook('agent_start')

    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    expect(harness.spawnMock).not.toHaveBeenCalled()
  })

  it('does not hold Pi event dispatch open while hook delivery is pending', async () => {
    let finishDelivery: (() => void) | undefined
    const harness = createHarness({
      kind: 'pi',
      fetchImpl: vi.fn(
        () =>
          new Promise((resolve) => {
            finishDelivery = () => resolve({ ok: true })
          })
      )
    })

    let handlerReturned = false
    const handlerCall = harness.callHook('agent_start').then(() => {
      handlerReturned = true
    })
    await Promise.resolve()

    // Why: Pi awaits extension handlers, so loopback status delivery cannot
    // remain on the agent's critical path when Orca is stalled or restarting.
    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(handlerReturned).toBe(true))

    finishDelivery?.()
    await handlerCall
  })

  it('leaves runtime shutdown to PTY teardown instead of reporting turn completion', () => {
    const harness = createHarness({ kind: 'pi' })

    // Why: Pi emits session_shutdown for reload/new/resume/fork while its PTY
    // stays alive. agent_end is the only extension event that proves done.
    expect(harness.handlers.session_shutdown).toBeUndefined()
  })

  it('bounds stalled delivery to one active request and the latest pending status', async () => {
    const finishDeliveries: (() => void)[] = []
    const harness = createHarness({
      kind: 'pi',
      fetchImpl: vi.fn(
        () =>
          new Promise((resolve) => {
            finishDeliveries.push(() => resolve({ ok: true }))
          })
      )
    })

    await Promise.all([
      harness.callHook('agent_start'),
      harness.callHook('tool_execution_start', { toolName: 'read', args: { path: 'one.ts' } }),
      harness.callHook('agent_end')
    ])

    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    finishDeliveries[0]?.()
    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(2))
    const latestBody = JSON.parse(String(harness.fetchMock.mock.calls[1]?.[1]?.body))
    expect(latestBody.payload).toEqual({ hook_event_name: 'agent_end' })

    finishDeliveries[1]?.()
  })

  it('abandons a stalled request after one second and delivers the latest status', async () => {
    vi.useFakeTimers()
    try {
      let requestCount = 0
      const harness = createHarness({
        kind: 'pi',
        fetchImpl: vi.fn(() => {
          requestCount += 1
          return requestCount === 1 ? new Promise(() => {}) : Promise.resolve({ ok: true })
        })
      })

      await harness.callHook('agent_start')
      await harness.callHook('agent_end')

      expect(harness.fetchMock).toHaveBeenCalledTimes(1)
      const firstSignal = harness.fetchMock.mock.calls[0]?.[1]?.signal as AbortSignal
      expect(firstSignal.aborted).toBe(false)

      await vi.advanceTimersByTimeAsync(1000)

      expect(firstSignal.aborted).toBe(true)
      expect(harness.fetchMock).toHaveBeenCalledTimes(2)
      const latestBody = JSON.parse(String(harness.fetchMock.mock.calls[1]?.[1]?.body))
      expect(latestBody.payload).toEqual({ hook_event_name: 'agent_end' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports only agent_settled after multiple first-run agent_end events', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness({ kind: 'pi' })
      const context = { isIdle: vi.fn(() => false) }

      for (let index = 0; index < 3; index += 1) {
        await harness.callHook('agent_end', undefined, context)
        await vi.advanceTimersByTimeAsync(700)
      }
      expect(harness.fetchMock).not.toHaveBeenCalled()

      await harness.callHook('agent_settled')
      await vi.advanceTimersByTimeAsync(0)

      expect(harness.fetchMock).toHaveBeenCalledTimes(1)
      expect(JSON.parse(String(harness.fetchMock.mock.calls[0]?.[1]?.body)).payload).toEqual({
        hook_event_name: 'agent_end'
      })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not duplicate completion when idle is observed before agent_settled', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness({ kind: 'pi' })
      const context = { isIdle: vi.fn(() => true) }

      await harness.callHook('agent_end', undefined, context)
      await vi.advanceTimersByTimeAsync(0)
      expect(harness.fetchMock).toHaveBeenCalledTimes(1)

      await harness.callHook('agent_settled')
      await vi.advanceTimersByTimeAsync(0)

      expect(harness.fetchMock).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels an ambiguous agent_end when modern Pi resumes work', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness({ kind: 'pi' })
      const context = { isIdle: vi.fn(() => false) }

      await harness.callHook('agent_end', undefined, context)
      await vi.advanceTimersByTimeAsync(100)
      await harness.callHook('agent_start')
      await harness.callHook('agent_end', undefined, context)
      await vi.advanceTimersByTimeAsync(2_000)
      await harness.callHook('agent_settled')
      await vi.advanceTimersByTimeAsync(0)

      const events = harness.fetchMock.mock.calls.map(
        (call) => JSON.parse(String(call[1]?.body)).payload.hook_event_name
      )
      expect(events).toEqual(['agent_start', 'agent_end'])
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a pending legacy fallback when its context becomes stale on reload', async () => {
    vi.useFakeTimers()
    try {
      const harness = createHarness({ kind: 'pi' })
      let active = true
      const context = {
        isIdle: vi.fn(() => {
          if (!active) {
            throw new Error('stale extension context')
          }
          return false
        })
      }

      await harness.callHook('agent_end', undefined, context)
      await vi.advanceTimersByTimeAsync(100)
      active = false
      harness.reload()
      await vi.advanceTimersByTimeAsync(100)

      expect(harness.fetchMock).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps polling Pi and Prime until their agent_end handlers settle', async () => {
    vi.useFakeTimers()
    try {
      for (const kind of ['pi', 'prime-agent'] as const) {
        const harness = createHarness({ kind })
        let idle = false
        const context = { isIdle: vi.fn(() => idle) }

        await harness.callHook('agent_end', undefined, context)
        await vi.advanceTimersByTimeAsync(100)
        expect(harness.fetchMock).not.toHaveBeenCalled()

        idle = true
        await vi.advanceTimersByTimeAsync(100)
        expect(harness.fetchMock).toHaveBeenCalledTimes(1)
        expect(harness.handlers.agent_settled).toBeTypeOf('function')
      }
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps immediate agent_end fallback for runtimes without an idle context', async () => {
    const harness = createHarness({ kind: 'omp' })

    await harness.callHook('agent_end')
    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(1))
  })

  it('does not report a non-terminal OMP agent_end without an idle context', async () => {
    const harness = createHarness({ kind: 'omp' })

    await harness.callHook('agent_end', { willContinue: true })
    expect(harness.fetchMock).not.toHaveBeenCalled()

    await harness.callHook('agent_end')
    await vi.waitFor(() => expect(harness.fetchMock).toHaveBeenCalledTimes(1))
  })

  it('does not treat WSLENV alone as WSL evidence', async () => {
    const harness = createHarness({
      kind: 'omp',
      env: { WSLENV: 'FOO/u' },
      existsSync: () => true,
      readFileSync: (path) => {
        if (path === '/proc/sys/kernel/osrelease' || path === '/proc/version') {
          return 'Linux 6.8.0 generic'
        }
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      },
      fetchImpl: vi.fn(async () => {
        throw new Error('loopback unreachable')
      })
    })

    await harness.callHook('agent_start')

    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    expect(harness.spawnMock).not.toHaveBeenCalled()
  })

  it('remains fail-open when the Windows curl bridge is missing', async () => {
    const harness = createHarness({
      kind: 'omp',
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      existsSync: () => false,
      fetchImpl: vi.fn(async () => {
        throw new Error('loopback unreachable')
      })
    })

    await expect(harness.callHook('agent_start')).resolves.toBeUndefined()
    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    expect(harness.spawnMock).not.toHaveBeenCalled()
  })
})

import { createServer } from 'node:http'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { makePaneKey } from '../../shared/stable-pane-id'
import { HERMES_CLIENT_ENV_PASSTHROUGH } from './hermes-managed-plugin-source'
import { HermesHookService, _internals } from './hook-service'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')

describe('HermesHookService', () => {
  let homeDir: string
  let previousHermesHome: string | undefined

  beforeEach(() => {
    previousHermesHome = process.env.HERMES_HOME
    homeDir = mkdtempSync(join(tmpdir(), 'orca-hermes-hooks-'))
    process.env.HERMES_HOME = homeDir
  })

  afterEach(() => {
    if (previousHermesHome === undefined) {
      delete process.env.HERMES_HOME
    } else {
      process.env.HERMES_HOME = previousHermesHome
    }
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('installs the managed Hermes plugin and enables it in config.yaml', () => {
    const status = new HermesHookService().install()

    expect(status).toMatchObject({
      agent: 'hermes',
      state: 'installed',
      managedHooksPresent: true,
      detail: null
    })
    const pluginDir = join(homeDir, 'plugins', _internals.HERMES_PLUGIN_NAME)
    expect(readFileSync(join(pluginDir, 'plugin.yaml'), 'utf-8')).toContain('provides_hooks:')
    expect(readFileSync(join(pluginDir, '__init__.py'), 'utf-8')).toContain('/hook/hermes')
    const config = parse(readFileSync(join(homeDir, 'config.yaml'), 'utf-8')) as {
      plugins: { enabled: string[] }
    }
    expect(config.plugins.enabled).toContain(_internals.HERMES_PLUGIN_NAME)
  })

  it('preserves other enabled plugins and removes Orca from disabled list', () => {
    writeFileSync(
      join(homeDir, 'config.yaml'),
      [
        'model: test-model',
        'plugins:',
        '  enabled:',
        '    - disk-cleanup',
        '  disabled:',
        `    - ${_internals.HERMES_PLUGIN_NAME}`,
        ''
      ].join('\n'),
      'utf-8'
    )

    new HermesHookService().install()

    const config = parse(readFileSync(join(homeDir, 'config.yaml'), 'utf-8')) as {
      model: string
      plugins: { enabled: string[]; disabled: string[] }
    }
    expect(config.model).toBe('test-model')
    expect(config.plugins.enabled).toEqual(['disk-cleanup', _internals.HERMES_PLUGIN_NAME])
    expect(config.plugins.disabled).toEqual([])
  })

  it('passes pane identity through Hermes client env without dropping user entries', () => {
    const configPath = join(homeDir, 'config.yaml')
    writeFileSync(
      configPath,
      [
        'terminal:',
        '  backend: local',
        '  client_env_passthrough:',
        '    - MY_VAR # mine',
        '    - ORCA_TAB_ID',
        'plugins:',
        '  enabled: [other]',
        ''
      ].join('\n'),
      'utf-8'
    )
    const service = new HermesHookService()

    service.install()
    const installed = readFileSync(configPath, 'utf-8')
    expect(parse(installed).terminal).toEqual({
      backend: 'local',
      client_env_passthrough: [
        'MY_VAR',
        'ORCA_TAB_ID',
        'ORCA_AGENT_PANE',
        'ORCA_AGENT_LAUNCH',
        'ORCA_WORKTREE_ID',
        'ORCA_AGENT_HOOK_ENDPOINT',
        'ORCA_AGENT_HOOK_ENV',
        'ORCA_AGENT_HOOK_VERSION'
      ]
    })
    expect(installed).toContain('- MY_VAR # mine')
    service.install()
    expect(readFileSync(configPath, 'utf-8')).toBe(installed)

    service.remove()
    const removed = readFileSync(configPath, 'utf-8')
    expect(parse(removed)).toEqual({
      terminal: { backend: 'local', client_env_passthrough: ['MY_VAR'] },
      plugins: { enabled: ['other'] }
    })
    expect(removed).toContain('- MY_VAR # mine')
  })

  it('refreshes named profiles that keep the plugin enabled, and only those', () => {
    const stale = '# Managed by Orca. Do not edit; changes may be overwritten.\n# stale\n'
    // `hermes profile create --clone` copies the plugin but not later passthrough edits.
    const profile = (name: string, config: string): string => {
      const home = join(homeDir, 'profiles', name)
      const pluginDir = join(home, 'plugins', _internals.HERMES_PLUGIN_NAME)
      mkdirSync(pluginDir, { recursive: true })
      writeFileSync(join(pluginDir, 'plugin.yaml'), _internals.getPluginManifest())
      writeFileSync(join(pluginDir, '__init__.py'), stale)
      writeFileSync(join(home, 'config.yaml'), config)
      return home
    }
    const pluginSource = (home: string): string =>
      readFileSync(join(home, 'plugins', _internals.HERMES_PLUGIN_NAME, '__init__.py'), 'utf-8')
    const broken = profile('broken', '')
    rmSync(join(broken, 'config.yaml'))
    mkdirSync(join(broken, 'config.yaml'))
    const work = profile('work', 'plugins:\n  enabled: [orca-status]\n')
    const disabledConfig = 'plugins:\n  enabled: [orca-status]\n  disabled: [orca-status]\n'
    const disabled = profile('off', disabledConfig)
    const service = new HermesHookService()

    expect(service.install().state).toBe('installed')
    expect(parse(readFileSync(join(work, 'config.yaml'), 'utf-8')).terminal).toEqual({
      client_env_passthrough: [...HERMES_CLIENT_ENV_PASSTHROUGH]
    })
    expect(pluginSource(work)).toBe(_internals.getPluginInitSource())
    expect(readFileSync(join(disabled, 'config.yaml'), 'utf-8')).toBe(disabledConfig)
    expect(pluginSource(disabled)).toBe(stale)

    service.remove()
    expect(parse(readFileSync(join(work, 'config.yaml'), 'utf-8'))).toEqual({
      plugins: { enabled: [] },
      terminal: { client_env_passthrough: [] }
    })
  })

  it.each([
    ['an anchored terminal setting', 'terminal:\n  env: &env {A: "1"}\nshared: *env\n', true],
    ['a malformed passthrough', 'terminal:\n  client_env_passthrough: FOO\n', false],
    ['a scalar terminal', 'terminal: local\n', false],
    ['an anchored terminal', 'terminal: &t {backend: local}\nother: *t\n', false],
    ['a merge key in terminal', 'base: &b {backend: local}\nterminal:\n  <<: *b\n', false],
    ['an anchored passthrough', 'terminal:\n  client_env_passthrough: &p [A]\nx: *p\n', false]
  ])('still installs and removes the plugin beside %s', (_name, input, passesThrough) => {
    writeFileSync(join(homeDir, 'config.yaml'), input)

    const service = new HermesHookService()
    expect(service.install().state).toBe('installed')
    const { plugins, terminal, ...rest } = parse(
      readFileSync(join(homeDir, 'config.yaml'), 'utf-8')
    )
    const { terminal: original, ...originalRest } = parse(input)
    expect(plugins.enabled).toEqual(['orca-status'])
    expect(rest).toEqual(originalRest)
    expect(terminal).toEqual(
      passesThrough
        ? { ...original, client_env_passthrough: [...HERMES_CLIENT_ENV_PASSTHROUGH] }
        : original
    )
    expect(service.remove().state).toBe('not_installed')
  })

  it('adds the passthrough when a rewritten plugin list runs into a closing comment', () => {
    const configPath = join(homeDir, 'config.yaml')
    writeFileSync(
      configPath,
      'plugins:\n  disabled:\n    - keep\n    - orca-status # managed entry\n# End notes\n'
    )

    expect(new HermesHookService().install().state).toBe('installed')
    const installed = readFileSync(configPath, 'utf-8')
    expect(parse(installed)).toEqual({
      plugins: { disabled: ['keep'], enabled: ['orca-status'] },
      terminal: { client_env_passthrough: expect.arrayContaining(['ORCA_AGENT_PANE']) }
    })
    expect(installed.split('# End notes')).toHaveLength(2)
  })

  it('refuses malformed plugin lists during install', () => {
    writeFileSync(
      join(homeDir, 'config.yaml'),
      ['plugins:', '  enabled: "not-a-list"', '  disabled: "not-a-list"', ''].join('\n'),
      'utf-8'
    )

    const status = new HermesHookService().install()

    expect(status.state).toBe('error')
    const config = parse(readFileSync(join(homeDir, 'config.yaml'), 'utf-8')) as {
      plugins: { enabled: string[]; disabled: string[] }
    }
    expect(config.plugins.enabled).toBe('not-a-list')
    expect(config.plugins.disabled).toBe('not-a-list')
  })

  it('reports partial when the plugin exists but is not enabled', () => {
    new HermesHookService().install()
    const update = _internals.updateConfigContent(
      readFileSync(join(homeDir, 'config.yaml'), 'utf-8'),
      _internals.disablePlugin
    )
    expect(update.content).toBeTruthy()
    writeFileSync(join(homeDir, 'config.yaml'), update.content!, 'utf-8')

    const status = new HermesHookService().getStatus()

    expect(status.state).toBe('partial')
    expect(status.detail).toContain('not enabled')
  })

  it('is visible to the real hermes CLI when hermes is installed', () => {
    const hermesAvailable = spawnSync('hermes', ['--version'], { encoding: 'utf-8' }).status === 0
    if (!hermesAvailable) {
      return
    }
    new HermesHookService().install()

    const output = execFileSync('hermes', ['plugins', 'list'], {
      env: { ...process.env, HERMES_HOME: homeDir },
      encoding: 'utf-8',
      timeout: 15_000
    })

    expect(output).toContain(_internals.HERMES_PLUGIN_NAME)
    expect(output.toLowerCase()).toContain('enabled')
  }, 20_000)

  it('registered plugin hooks post normalized JSON to Orca', async () => {
    const pythonAvailable = spawnSync('python3', ['--version'], { encoding: 'utf-8' }).status === 0
    if (!pythonAvailable) {
      return
    }
    new HermesHookService().install()

    const received = new Promise<Record<string, unknown>>((resolve, reject) => {
      const server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          try {
            expect(req.url).toBe('/hook/hermes')
            expect(req.headers['x-orca-agent-hook-token']).toBe('token-1')
            res.writeHead(204)
            res.end()
            clearTimeout(timeout)
            server.close()
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>)
          } catch (error) {
            clearTimeout(timeout)
            server.close()
            reject(error)
          }
        })
      })
      const timeout = setTimeout(() => {
        server.close()
        reject(new Error('timed out waiting for Hermes plugin POST'))
      }, 5_000)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') {
          server.close()
          reject(new Error('server did not bind to a TCP port'))
          return
        }
        const initPath = join(homeDir, 'plugins', _internals.HERMES_PLUGIN_NAME, '__init__.py')
        const script = [
          'import importlib.util',
          `spec = importlib.util.spec_from_file_location("orca_status", ${JSON.stringify(initPath)})`,
          'mod = importlib.util.module_from_spec(spec)',
          'spec.loader.exec_module(mod)',
          'class Ctx:',
          '    def __init__(self): self.hooks = {}',
          '    def register_hook(self, name, callback): self.hooks[name] = callback',
          'ctx = Ctx()',
          'mod.register(ctx)',
          'ctx.hooks["pre_llm_call"](',
          '    session_id="sess-1",',
          '    user_message="make Hermes good",',
          '    is_first_turn=True,',
          '    model="test-model",',
          '    platform="cli",',
          ')'
        ].join('\n')
        // The Python hook calls this HTTP server; synchronous execution would deadlock its response.
        execFile(
          'python3',
          ['-c', script],
          {
            env: {
              ...process.env,
              ORCA_AGENT_HOOK_PORT: String(address.port),
              ORCA_AGENT_HOOK_TOKEN: 'token-1',
              ORCA_AGENT_HOOK_ENDPOINT: '',
              ORCA_PANE_KEY: PANE_KEY,
              ORCA_TAB_ID: 'tab-1',
              ORCA_WORKTREE_ID: 'wt-1',
              ORCA_AGENT_HOOK_ENV: 'production',
              ORCA_AGENT_HOOK_VERSION: '1'
            },
            encoding: 'utf-8'
          },
          (error) => {
            if (!error) {
              return
            }
            clearTimeout(timeout)
            server.close()
            reject(error)
          }
        )
      })
    })

    await expect(received).resolves.toMatchObject({
      paneKey: PANE_KEY,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      env: 'production',
      version: '1',
      payload: {
        hook_event_name: 'pre_llm_call',
        prompt: 'make Hermes good',
        user_message: 'make Hermes good'
      }
    })
  })

  it('attributes each shared-gateway session to its own pane, not the daemon pane', async () => {
    const pythonAvailable = spawnSync('python3', ['--version'], { encoding: 'utf-8' }).status === 0
    if (!pythonAvailable) {
      return
    }
    new HermesHookService().install()
    // Mirrors Hermes 0.22's agent.session_client_env: a session's client env is bound per turn.
    const hermesRoot = join(homeDir, 'hermes-src')
    mkdirSync(join(hermesRoot, 'agent'), { recursive: true })
    writeFileSync(join(hermesRoot, 'agent', '__init__.py'), '')
    writeFileSync(
      join(hermesRoot, 'agent', 'session_client_env.py'),
      [
        'from contextlib import contextmanager',
        'from contextvars import ContextVar',
        "_BOUND = ContextVar('session_client_env', default=None)",
        '@contextmanager',
        'def client_env_scope(env):',
        '    token = _BOUND.set(env)',
        '    try:',
        '        yield',
        '    finally:',
        '        _BOUND.reset(token)',
        'def bound_client_env():',
        '    return _BOUND.get()'
      ].join('\n')
    )

    const received: Record<string, unknown>[] = []
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
        res.writeHead(204)
        res.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('server did not bind to a TCP port')
      }
      const endpointPath = join(homeDir, 'endpoint.env')
      writeFileSync(
        endpointPath,
        `ORCA_AGENT_HOOK_PORT=${address.port}\nORCA_AGENT_HOOK_TOKEN=token-1\n`
      )
      const initPath = join(homeDir, 'plugins', _internals.HERMES_PLUGIN_NAME, '__init__.py')
      const pane = (id: string) =>
        `{"ORCA_AGENT_PANE": "tab-${id}:pane-${id}", "ORCA_AGENT_LAUNCH": "launch-${id}", "ORCA_TAB_ID": "tab-${id}", "ORCA_WORKTREE_ID": "wt-${id}", "ORCA_AGENT_HOOK_ENDPOINT": ${JSON.stringify(endpointPath)}}`
      const script = [
        'import importlib.util',
        'from agent.session_client_env import client_env_scope',
        `spec = importlib.util.spec_from_file_location("orca_status", ${JSON.stringify(initPath)})`,
        'mod = importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(mod)',
        'class Ctx:',
        '    def __init__(self): self.hooks = {}',
        '    def register_hook(self, name, callback): self.hooks[name] = callback',
        'ctx = Ctx()',
        'mod.register(ctx)',
        `with client_env_scope(${pane('B')}):`,
        '    ctx.hooks["pre_llm_call"](session_id="sess-B", user_message="from B")',
        `with client_env_scope(${pane('C')}):`,
        '    ctx.hooks["pre_tool_call"](session_id="sess-C", tool_name="patch")',
        '# Gateway housekeeping runs outside any session, so it has no proven pane.',
        'ctx.hooks["on_session_finalize"](session_id="sess-B", platform="local")',
        '# A non-Orca shell attached to the same gateway.',
        'with client_env_scope({"PATH": "/usr/bin"}):',
        '    ctx.hooks["pre_llm_call"](session_id="sess-X", user_message="not a pane")'
      ].join('\n')
      await new Promise<void>((resolve, reject) => {
        // The Python hook calls this HTTP server; synchronous execution would deadlock its response.
        execFile(
          'python3',
          ['-c', script],
          {
            env: {
              ...process.env,
              PYTHONPATH: hermesRoot,
              ORCA_AGENT_HOOK_PORT: String(address.port),
              ORCA_AGENT_HOOK_TOKEN: 'token-1',
              ORCA_AGENT_HOOK_ENDPOINT: '',
              ORCA_PANE_KEY: 'tab-A:pane-A',
              ORCA_AGENT_PANE: 'tab-A:pane-A',
              ORCA_AGENT_LAUNCH_TOKEN: 'launch-A',
              ORCA_TAB_ID: 'tab-A',
              ORCA_WORKTREE_ID: 'wt-A'
            },
            encoding: 'utf-8',
            timeout: 15_000
          },
          (error) => (error ? reject(error) : resolve())
        )
      })
    } finally {
      server.close()
    }

    expect(received).toMatchObject([
      {
        paneKey: 'tab-B:pane-B',
        launchToken: 'launch-B',
        tabId: 'tab-B',
        worktreeId: 'wt-B',
        payload: { hook_event_name: 'pre_llm_call', session_id: 'sess-B' }
      },
      {
        paneKey: 'tab-C:pane-C',
        launchToken: 'launch-C',
        tabId: 'tab-C',
        worktreeId: 'wt-C',
        payload: { hook_event_name: 'pre_tool_call', session_id: 'sess-C' }
      }
    ])
    expect(received).toHaveLength(2)
  })

  it('bounds generated plugin payload normalization before JSON encoding', () => {
    const pythonAvailable = spawnSync('python3', ['--version'], { encoding: 'utf-8' }).status === 0
    if (!pythonAvailable) {
      return
    }
    new HermesHookService().install()

    const initPath = join(homeDir, 'plugins', _internals.HERMES_PLUGIN_NAME, '__init__.py')
    const script = [
      'import importlib.util, json',
      `spec = importlib.util.spec_from_file_location("orca_status", ${JSON.stringify(initPath)})`,
      'mod = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(mod)',
      'payload = mod._payload_for_event("post_tool_call", {',
      '    "session_id": "sess-1",',
      '    "tool_name": "BigTool",',
      '    "args": {"long": "x" * 9000, "items": list(range(200))},',
      '    "result": {"text": "y" * 9000, "nested": [{"value": i} for i in range(200)]},',
      '    "duration_ms": 12,',
      '})',
      'print(json.dumps(payload))'
    ].join('\n')

    const output = execFileSync('python3', ['-c', script], {
      encoding: 'utf-8',
      timeout: 15_000
    })
    const payload = JSON.parse(output) as {
      args: { long: string; items: unknown[] }
      result: { text: string; nested: unknown[] }
      tool_input: { items: unknown[] }
    }

    expect(payload.args.long).toHaveLength(8192 + '...[truncated]'.length)
    expect(payload.args.long.endsWith('...[truncated]')).toBe(true)
    expect(payload.args.items).toHaveLength(51)
    expect(payload.args.items.at(-1)).toBe('...[truncated]')
    expect(payload.result.text.endsWith('...[truncated]')).toBe(true)
    expect(payload.result.nested).toHaveLength(51)
    expect(payload.tool_input.items).toHaveLength(51)
  })
})

import { createServer } from 'http'
import { execFileSync, spawnSync } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { makePaneKey } from '../../shared/stable-pane-id'
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

  it('normalizes malformed plugin lists during install', () => {
    writeFileSync(
      join(homeDir, 'config.yaml'),
      ['plugins:', '  enabled: "not-a-list"', '  disabled: "not-a-list"', ''].join('\n'),
      'utf-8'
    )

    const status = new HermesHookService().install()

    expect(status.state).toBe('installed')
    const config = parse(readFileSync(join(homeDir, 'config.yaml'), 'utf-8')) as {
      plugins: { enabled: string[]; disabled: string[] }
    }
    expect(config.plugins.enabled).toEqual([_internals.HERMES_PLUGIN_NAME])
    expect(config.plugins.disabled).toEqual([])
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
  })

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
        try {
          execFileSync('python3', ['-c', script], {
            env: {
              ...process.env,
              ORCA_AGENT_HOOK_PORT: String(address.port),
              ORCA_AGENT_HOOK_TOKEN: 'token-1',
              ORCA_PANE_KEY: PANE_KEY,
              ORCA_TAB_ID: 'tab-1',
              ORCA_WORKTREE_ID: 'wt-1',
              ORCA_AGENT_HOOK_ENV: 'production',
              ORCA_AGENT_HOOK_VERSION: '1'
            },
            encoding: 'utf-8'
          })
        } catch (error) {
          clearTimeout(timeout)
          server.close()
          reject(error)
        }
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
})

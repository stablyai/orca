import { runProcess } from '../shared/child-process/run-process'
import { getPosixOmpShellWrapper } from '../main/pty/omp-shell-wrapper'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RelayDispatcher } from './dispatcher'
import { PtyHandler } from './pty-handler'
import { RelayAgentHookRuntime } from './relay-agent-hook-runtime'
import { PluginOverlayManager } from './plugin-overlay'
import { withFreshOmpLaunch } from '../shared/omp-fresh-launch'

const state = vi.hoisted(() => ({ home: '' }))
vi.mock('node:os', async (original) => ({
  ...(await original<typeof NodeOs>()),
  homedir: () => state.home
}))
afterEach(() => {
  vi.restoreAllMocks()
  if (state.home) {
    rmSync(state.home, { recursive: true, force: true })
  }
})

it('prepares the execution host OMP config and status extension for a guarded launch', async () => {
  state.home = mkdtempSync(join(tmpdir(), 'orca-relay-fresh-'))
  const dispatcher = new RelayDispatcher(() => {})
  const handler = new PtyHandler(dispatcher)
  const augment = vi.spyOn(handler, 'addEnvAugmenter')
  const source = vi.spyOn(PluginOverlayManager.prototype, 'hasPiSource').mockReturnValue(true)
  const original = PluginOverlayManager.prototype.materializePi
  vi.spyOn(PluginOverlayManager.prototype, 'materializePi').mockImplementation(function (
    this: PluginOverlayManager,
    ...args
  ) {
    this.setSources({ ompExtensionSource: '// Orca managed test status extension' })
    return original.apply(this, args)
  })
  const runtime = new RelayAgentHookRuntime(
    dispatcher,
    handler,
    join(state.home, 'relay.sock'),
    join(state.home, 'hooks')
  )
  await runtime.start()
  try {
    const environment = await augment.mock.calls[1][0]({
      id: 'fresh-pane',
      shell: '/bin/bash',
      env: { HOME: state.home },
      command: withFreshOmpLaunch('omp', 'posix')
    })
    expect(readFileSync(environment.ORCA_OMP_FRESH_CONFIG, 'utf8')).toBe('autoResume: false\n')
    expect(existsSync(environment.ORCA_OMP_STATUS_EXTENSION)).toBe(true)
    expect(environment.ORCA_OMP_SOURCE_AGENT_DIR).toBe(join(state.home, '.omp', 'agent'))
    expect(environment.PI_CODING_AGENT_DIR).toBeUndefined()
    expect(environment.ORCA_PI_SOURCE_AGENT_DIR).toBeUndefined()
    if (process.platform !== 'win32' && existsSync('/bin/bash')) {
      writeFileSync(
        join(state.home, 'omp'),
        '#!/bin/sh\nprintf "%s\\n" "$@" "$ORCA_OMP_PREFILL"\nexit 17\n',
        { mode: 0o755 }
      )
      const result = await runProcess({
        program: '/bin/bash',
        args: [
          '--noprofile',
          '--norc',
          '-c',
          `${getPosixOmpShellWrapper()}\n${withFreshOmpLaunch('omp', 'posix')}`
        ],
        cwd: state.home,
        env: {
          ...process.env,
          ...environment,
          PATH: state.home + delimiter + process.env.PATH,
          ORCA_OMP_PREFILL: 'remote draft'
        }
      })
      expect(result.code).toBe(17)
      expect(result.stdout.trim().split('\n')).toEqual([
        '--extension',
        environment.ORCA_OMP_STATUS_EXTENSION,
        '--config',
        environment.ORCA_OMP_FRESH_CONFIG,
        'remote draft'
      ])
    }

    source.mockReturnValue(false)
    expect(
      augment.mock.calls[1][0]({ id: 'other', shell: '/bin/bash', env: {}, command: 'codex' })
    ).toEqual({})
  } finally {
    runtime.stop()
    dispatcher.dispose()
  }
})

it('fails the config guard safely when the relay-owned directory cannot be created', () => {
  state.home = mkdtempSync(join(tmpdir(), 'orca-relay-fresh-fail-'))
  const blocked = join(state.home, 'file')
  writeFileSync(blocked, '')
  const manager = new PluginOverlayManager({ homeDir: blocked })
  expect(manager.materializeOmpFreshConfig()).toBe('')
})

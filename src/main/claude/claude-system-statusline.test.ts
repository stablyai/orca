import { expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  seam,
  current,
  service,
  file,
  read,
  write,
  install,
  remove,
  erase,
  storage,
  documentPath,
  document,
  failure,
  applyAgentStatusHooksEnabled,
  main,
  slot,
  resetService
} from './claude-system-statusline.test-fixture'
it('distinguishes unknown legacy C=E from modern deletion and preserves user and profile slots', async () => {
  const marker = join(seam.home, '.orca/agent-hooks/claude-statusline.installed')
  await fs.mkdir(dirname(marker), { recursive: true })
  await fs.writeFile(marker, '')
  await write(file('.claude'), {})
  expect((await install('fresh-legacy')).state).toBe('installed')
  expect((await read(file('fresh-legacy'))).statusLine).toBeDefined()
  const legacyManaged = await read(file('fresh-legacy'))
  await remove('fresh-legacy')
  await fs.writeFile(marker, '')
  expect((await install('.claude')).state).toBe('installed')
  expect(slot(await read(file('.claude')))).toBe('managed')
  await remove('.claude')
  await fs.writeFile(marker, '')
  await write(file('.claude'), legacyManaged)
  const conventional = await fs.readFile(file('.claude'), 'utf8')
  expect((await install('legacy-migration')).state).toBe('installed')
  expect((await install('legacy-migration')).state).toBe('installed')
  expect(await fs.readFile(file('.claude'), 'utf8')).toBe(conventional)
  expect(
    (await document()).destinations.some(
      (entry: { path: string }) => entry.path === file('.claude')
    )
  ).toBe(false)
  await erase('.claude')
  const deletedConventional = await fs.readFile(file('.claude'), 'utf8')
  expect((await install('X')).state).toBe('installed')
  expect((await read(file('X'))).statusLine).toBeDefined()
  expect((await install('X')).state).toBe('installed')
  expect(await fs.readFile(file('.claude'), 'utf8')).toBe(deletedConventional)
  await write(file('U'), { statusLine: { command: '/user/custom', type: 'command' } })
  expect((await install('U')).state).toBe('installed')
  expect((await read(file('U'))).statusLine.command).toBe('/user/custom')
  const before = await document()
  expect(
    service().installProfile({
      ...current,
      target: { kind: 'profile', configDir: dirname(file('profile')) }
    }).state
  ).toBe('installed')
  expect(await document()).toEqual(before)
  expect((await read(file('profile'))).statusLine).toBeUndefined()
  expect(await fs.readFile(marker, 'utf8')).toBe('')
})

it('retains independent owners and copied managed adoption, with reset and legitimate re-enable', async () => {
  expect((await install('X')).state).toBe('installed')
  const managed = await read(file('X'))
  await write(file('Y'), managed)
  expect((await install('Y')).state).toBe('installed')
  await erase('X')
  expect((await install('Z')).state).toBe('installed')
  expect((await read(file('Z'))).statusLine).toBeDefined()
  expect((await install('Y')).state).toBe('installed')
  expect((await read(file('Y'))).statusLine).toBeDefined()
  expect((await install('X')).state).toBe('installed')
  expect((await read(file('X'))).statusLine).toBeUndefined()
  expect((await remove('Z')).state).toBe('not_installed')
  expect((await document()).destinations).toHaveLength(2)
  expect((await install('X')).state).toBe('installed')
  expect((await read(file('X'))).statusLine).toBeUndefined()
  await remove('X')
  expect((await install('X')).state).toBe('installed')
  expect((await read(file('X'))).statusLine).toBeDefined()
})

it.skipIf(process.platform === 'win32')(
  'binds directory and final-file aliases, redirects and replaced parents to actual physical destinations',
  async () => {
    await write(file('P'), {})
    await fs.symlink(dirname(file('P')), dirname(file('A')))
    expect((await install('A')).state).toBe('installed')
    expect((await document()).destinations[0].path).toBe(file('P'))
    await fs.unlink(dirname(file('A')))
    await fs.mkdir(dirname(file('B')))
    await fs.symlink(file('P'), file('B'))
    expect((await install('B')).state).toBe('installed')
    expect((await document()).destinations).toHaveLength(1)
    await erase('P')
    expect((await install('B')).state).toBe('installed')
    expect((await read(file('P'))).statusLine).toBeUndefined()
    await write(file('Q'), {})
    await fs.unlink(file('B'))
    await fs.symlink(file('Q'), file('B'))
    expect((await install('B')).state).toBe('installed')
    expect((await read(file('Q'))).statusLine).toBeDefined()
    expect((await read(file('P'))).statusLine).toBeUndefined()
    await write(file('copy'), await read(file('P')))
    expect((await install('copy')).state).toBe('installed')
    expect((await read(file('copy'))).statusLine).toBeDefined()
    await fs.rename(dirname(file('P')), join(seam.home, 'old-parent'))
    await write(file('P'), {})
    expect((await install('P')).state).toBe('installed')
    expect((await read(file('P'))).statusLine).toBeDefined()
  }
)

it('reports failed acquisition, heals surviving M, and treats loss before acquisition as unknown', async () => {
  seam.before = async (method, path) => {
    if (method === 'rename' && dirname(path) === storage() && path.endsWith('.json')) {
      throw failure()
    }
  }
  expect((await install('X')).state).toBe('error')
  expect((await read(file('X'))).statusLine).toBeDefined()
  seam.before = null
  expect((await install('X')).state).toBe('installed')
  expect((await document()).destinations).toHaveLength(1)
  await remove('X')
  seam.before = async (method, path) => {
    if (method === 'rename' && dirname(path) === storage() && path.endsWith('.json')) {
      throw failure()
    }
  }
  expect((await install('Y')).state).toBe('error')
  await erase('Y')
  seam.before = null
  expect((await install('Z')).state).toBe('installed')
  expect((await read(file('Z'))).statusLine).toBeDefined()
})

it.skipIf(process.platform === 'win32')(
  'keeps native publisher modes, dangling refusal and failed rename/cleanup outcomes through the real service',
  async () => {
    await write(file('X'), {})
    await fs.chmod(file('X'), 0o640)
    const original = await fs.readFile(file('X'), 'utf8')
    seam.before = async (method, path) => {
      if (method === 'rename' && path === file('X')) {
        throw Object.assign(new Error('injected cross-mount publication'), { code: 'EXDEV' })
      }
    }
    expect((await install('X')).state).toBe('error')
    expect(await fs.readFile(file('X'), 'utf8')).toBe(original)
    let failedCleanup = false
    seam.before = async (method, path) => {
      if (
        method === 'rm' &&
        path.startsWith(`${file('X')}.`) &&
        path.endsWith('.tmp') &&
        !failedCleanup
      ) {
        failedCleanup = true
        throw failure()
      }
    }
    expect((await install('X')).state).toBe('error')
    expect((await read(file('X'))).hooks.SessionStart).toHaveLength(1)
    seam.before = null
    expect((await install('X')).state).toBe('installed')
    expect((await fs.stat(file('X'))).mode & 0o777).toBe(0o640)
    expect((await fs.stat(await documentPath())).mode & 0o777).toBe(0o600)
    expect((await fs.stat(storage())).mode & 0o777).toBe(0o700)
    await fs.mkdir(dirname(file('dangling')))
    await fs.symlink(file('absent'), file('dangling'))
    expect((await install('dangling')).state).toBe('error')
    expect((await fs.lstat(file('dangling'))).isSymbolicLink()).toBe(true)
    await expect(fs.stat(file('absent'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fs.readdir(dirname(file('X')))).filter((name) => name.endsWith('.tmp'))).toEqual(
      []
    )
  }
)

it('preserves malformed settings and metadata, completes safe events and reports optional failure truthfully', async () => {
  await install('X')
  const meta = await documentPath()
  const original = await fs.readFile(meta, 'utf8')
  await fs.writeFile(meta, '{broken')
  await write(file('fresh'), {})
  const result = await install('fresh')
  expect(result.state).toBe('error')
  expect(result.managedHooksPresent).toBe(true)
  expect((await read(file('fresh'))).statusLine).toBeUndefined()
  expect((await remove('fresh')).state).toBe('error')
  expect((await read(file('fresh'))).hooks.SessionStart).toBeUndefined()
  expect(await fs.readFile(meta, 'utf8')).toBe('{broken')
  await fs.writeFile(meta, original)
  for (const raw of ['null', '{invalid']) {
    await fs.writeFile(file('fresh'), raw)
    expect((await install('fresh')).state).toBe('error')
    expect(await fs.readFile(file('fresh'), 'utf8')).toBe(raw)
  }
  expect((await install('normal')).state).toBe('installed')
  expect((await read(file('normal'))).statusLine).toBeDefined()
})

it('keeps own-change nonauthoritative through failed post-rename cleanup and never replays old retirement against U', async () => {
  await install('X')
  seam.after = async (method, path) => {
    if (
      method === 'rename' &&
      path === file('X') &&
      (await document()).destinations[0].phase === 'own-change'
    ) {
      throw failure()
    }
  }
  expect((await install('X', { claudeVersion: '1.0.0' })).state).toBe('error')
  expect((await read(file('X'))).statusLine).toBeUndefined()
  expect((await document()).destinations[0].phase).toBe('own-change')
  seam.after = null
  await write(file('X'), { statusLine: { type: 'command', command: '/user/replaced' } })
  expect((await install('fresh')).state).toBe('installed')
  expect((await read(file('fresh'))).statusLine).toBeDefined()
  expect((await read(file('X'))).statusLine.command).toBe('/user/replaced')
  expect(
    (await document()).destinations.some((entry: { path: string }) => entry.path === file('X'))
  ).toBe(true)
  await install('Y')
  seam.after = async (method, path) => {
    if (method === 'rename' && path === file('Y') && !(await read(file('Y'))).statusLine) {
      throw failure()
    }
  }
  expect((await install('Y', { claudeVersion: '1.0.0' })).state).toBe('error')
  seam.after = null
  expect((await install('Y')).state).toBe('installed')
  expect((await read(file('Y'))).statusLine).toBeDefined()
})

it('journals own retirement, recovers without replay, and does not retire a genuine deletion', async () => {
  await install('X')
  const meta = await documentPath()
  seam.before = async (method, path) => {
    if (method === 'rename' && path === meta) {
      throw failure()
    }
  }
  expect((await install('X', { claudeVersion: '1.0.0' })).state).toBe('error')
  expect((await read(file('X'))).statusLine).toBeDefined()
  seam.before = null
  let live = true
  seam.after = async (method, path) => {
    if (method === 'rename' && path === meta) {
      live = false
    }
  }
  expect(
    (
      await service().installSystem({
        claudeVersion: '1.0.0',
        target: { kind: 'system-default', configDir: dirname(file('X')) },
        shouldContinue: () => live
      })
    ).state
  ).toBe('error')
  expect((await read(file('X'))).statusLine).toBeDefined()
  expect((await document()).destinations[0].phase).toBe('own-change')
  seam.after = null
  seam.before = async (method, path) => {
    if (
      method === 'rename' &&
      path === file('X') &&
      (await document()).destinations[0].phase === 'own-change'
    ) {
      throw failure()
    }
  }
  expect((await install('X', { claudeVersion: '1.0.0' })).state).toBe('error')
  expect((await document()).destinations[0].phase).toBe('own-change')
  seam.before = null
  expect((await install('X')).state).toBe('installed')
  expect(
    (await document()).destinations.find((entry: { path: string }) => entry.path === file('X'))
      .phase
  ).toBe('managed')
  await install('X', { claudeVersion: '1.0.0' })
  expect((await read(file('X'))).statusLine).toBeUndefined()
  await install('X')
  expect((await read(file('X'))).statusLine).toBeDefined()
  await erase('X')
  await install('X', { claudeVersion: '1.0.0' })
  await install('X')
  expect((await read(file('X'))).statusLine).toBeUndefined()
})

it('does not manufacture deletion when a missing recorded file is recreated, and fails safely on journal error', async () => {
  await install('X')
  await fs.symlink(dirname(file('X')), dirname(file('linked')), 'junction')
  await fs.unlink(file('X'))
  const meta = await documentPath()
  seam.before = async (method, path) => {
    if (method === 'rename' && path === meta) {
      throw failure()
    }
  }
  const failed = await install('linked')
  expect(failed.state).toBe('error')
  expect(failed.managedHooksPresent).toBe(false)
  await expect(fs.readFile(file('X'))).rejects.toMatchObject({ code: 'ENOENT' })
  const others = await applyAgentStatusHooksEnabled(true, null, {
    agents: ['claude', 'gemini'],
    env: { CLAUDE_CONFIG_DIR: dirname(file('linked')) }
  })
  expect(others.map((entry) => entry.state)).toEqual(['error', 'installed'])
  await expect(fs.readFile(file('X'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await read(join(seam.home, '.gemini/settings.json'))).hooks).toBeDefined()
  seam.before = null
  expect((await install('linked', { claudeVersion: '1.0.0' })).state).toBe('installed')
  expect((await read(file('X'))).statusLine).toBeUndefined()
  expect((await install('linked')).state).toBe('installed')
  expect(slot(await read(file('X')))).toBe('managed')
  expect((await document()).destinations.map((entry: { path: string }) => entry.path)).toEqual([
    file('X')
  ])
  expect((await fs.lstat(dirname(file('linked')))).isSymbolicLink()).toBe(true)
  expect((await install('Y')).state).toBe('installed')
  expect((await read(file('Y'))).statusLine).toBeDefined()
  await erase('Y')
  await install('Y', { claudeVersion: '1.0.0' })
  await install('Y')
  expect((await read(file('Y'))).statusLine).toBeUndefined()
})

it('resets authority before removals and verifies uncertain metadata publication without reviving backups', async () => {
  await install('X')
  const meta = await documentPath()
  const before = await document()
  seam.before = async (method, path) => {
    if (method === 'rename' && path === meta) {
      throw failure()
    }
  }
  expect((await remove('X')).state).toBe('error')
  expect((await read(file('X'))).statusLine).toBeDefined()
  expect(await document()).toEqual(before)
  seam.before = async (method, path) => {
    if (method === 'rename' && path === file('X')) {
      throw failure()
    }
  }
  expect((await remove('X')).state).toBe('error')
  expect((await document()).destinations).toEqual([])
  seam.before = null
  await install('X')
  seam.after = async (method, path) => {
    if (method === 'rename' && path === meta) {
      throw failure()
    }
  }
  expect((await remove('X')).state).toBe('not_installed')
  seam.after = null
  expect((await document()).destinations).toEqual([])
  expect((await document()).revision).not.toBe(before.revision)
})

it('runs desktop controls and actual online/offline CLI on/off with independent invocation roots', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {})
  const errors = vi.spyOn(console, 'error')
  const env = { CLAUDE_CONFIG_DIR: dirname(file('X')) }
  expect(
    (await applyAgentStatusHooksEnabled(true, null, { agents: ['claude'], env }))[0].state
  ).toBe('installed')
  vi.stubEnv('CLAUDE_CONFIG_DIR', dirname(file('Y')))
  await main(['agent', 'hooks', 'on', '--json'])
  expect((await read(file('Y'))).statusLine).toBeDefined()
  await erase('X')
  seam.online = false
  await fs.mkdir(join(seam.home, 'data'), { recursive: true })
  vi.stubEnv('CLAUDE_CONFIG_DIR', dirname(file('Z')))
  await main(['agent', 'hooks', 'on', '--json'])
  expect((await read(file('Z'))).statusLine).toBeDefined()
  vi.stubEnv('CLAUDE_CONFIG_DIR', dirname(file('X')))
  await main(['agent', 'hooks', 'on', '--json'])
  expect((await read(file('X'))).statusLine).toBeUndefined()
  vi.stubEnv('CLAUDE_CONFIG_DIR', dirname(file('Z')))
  await main(['agent', 'hooks', 'off', '--json'])
  await main(['agent', 'hooks', 'on', '--json'])
  expect((await read(file('Z'))).statusLine).toBeDefined()
  expect(errors).not.toHaveBeenCalled()
  expect(output).toHaveBeenCalled()
  expect(process.exitCode).toBeUndefined()
  const invocation = { agents: ['claude'] as const, env: { CLAUDE_CONFIG_DIR: dirname(file('Z')) } }
  expect(
    (
      await applyAgentStatusHooksEnabled(false, null, {
        ...invocation,
        shouldContinue: () => false
      })
    )[0].state
  ).toBe('not_installed')
  expect((await read(file('Z'))).statusLine).toBeUndefined()
  expect(
    (await document()).destinations.some((entry: { path: string }) => entry.path === file('X'))
  ).toBe(true)
  expect(
    (
      await applyAgentStatusHooksEnabled(true, null, { ...invocation, shouldContinue: () => true })
    )[0].state
  ).toBe('installed')
  expect((await read(file('Z'))).statusLine).toBeDefined()
})

it('bounds canceled pure current reads, joins other installers, preserves charged slots and retries on a legitimate wake', async () => {
  await install('X')
  const meta = await documentPath()
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  let admitted = 0,
    finished = 0
  let readbacks = 0,
    settled!: () => void
  const rawCompleted = new Promise<void>((resolve) => {
    settled = resolve
  })
  seam.after = async (method, path) => {
    if (
      method === 'stat' &&
      [dirname(file('P')), dirname(file('Q'))].includes(path) &&
      ++readbacks === 2
    ) {
      settled()
    }
  }
  let nextAdmission!: () => void
  seam.before = async (method, path) => {
    if (method === 'readFile' && path === meta) {
      admitted++
      nextAdmission?.()
      await blocked
      finished++
    }
  }
  const invoke = async (name: string, cancel = true) => {
    const controller = new AbortController()
    const ready = new Promise<void>((resolve) => {
      nextAdmission = resolve
    })
    await write(file(name), {})
    const pending = applyAgentStatusHooksEnabled(true, null, {
      agents: ['claude', 'gemini'],
      env: { CLAUDE_CONFIG_DIR: dirname(file(name)) },
      signal: controller.signal
    })
    await ready
    if (cancel) {
      controller.abort()
    }
    expect((await pending).map((entry) => entry.state)).toEqual(['error', 'installed'])
    expect((await read(file(name))).hooks.SessionStart).toHaveLength(1)
    expect((await read(file(name))).statusLine).toBeUndefined()
  }
  const started = performance.now()
  await invoke('P')
  await invoke('Q', false)
  expect(admitted).toBe(2)
  expect(finished).toBe(0)
  await write(file('capacity'), {})
  const denied = await install('capacity')
  expect(denied.state).toBe('error')
  expect(denied.managedHooksPresent).toBe(true)
  expect(admitted).toBe(2)
  seam.before = null
  // Reset is a legitimate new invocation, but cannot replace abandoned evidence chains.
  expect((await remove('X')).state).toBe('error')
  release()
  await rawCompleted
  await new Promise((resolve) => setImmediate(resolve))
  expect(finished).toBe(2)
  expect((await read(file('X'))).statusLine).toBeDefined()
  expect((await remove('X')).state).toBe('not_installed')
  const reset = await fs.readFile(meta, 'utf8')
  await new Promise((resolve) => setImmediate(resolve))
  expect(await fs.readFile(meta, 'utf8')).toBe(reset)
  expect((await install('P')).state).toBe('installed')
  console.log(
    'SL_CURRENT_CANCEL',
    JSON.stringify({ elapsed: performance.now() - started, admitted, finished })
  )
})

it('keeps safe event work under real runtime-host and zero-parent identity failures', async () => {
  await write(file('X'), { model: 'opus' })
  seam.unavailableHost = true
  await resetService()
  const runtime = await applyAgentStatusHooksEnabled(true, null, {
    agents: ['claude', 'gemini'],
    env: { CLAUDE_CONFIG_DIR: dirname(file('X')) }
  })
  expect(runtime.map((entry) => entry.state)).toEqual(['error', 'installed'])
  expect(runtime[0].managedHooksPresent).toBe(true)
  expect((await read(file('X'))).hooks.SessionStart).toHaveLength(1)
  expect((await read(file('X'))).statusLine).toBeUndefined()
  expect((await fs.readdir(storage())).filter((name) => name.endsWith('.json'))).toEqual([])
  expect((await remove('X')).state).toBe('error')
  expect((await read(file('X'))).hooks.SessionStart).toBeUndefined()
  seam.unavailableHost = false
  await resetService()
  await install('X')
  const callback = (await read(file('X'))).statusLine
  seam.zeroParent = dirname(file('X'))
  const zero = await install('X')
  expect(zero.state).toBe('error')
  expect(zero.managedHooksPresent).toBe(true)
  expect((await read(file('X'))).statusLine).toEqual(callback)
  expect((await remove('X')).state).toBe('error')
  expect((await read(file('X'))).hooks.SessionStart).toBeUndefined()
  expect((await read(file('X'))).statusLine).toEqual(callback)
})

it('detaches superseded P from shared preparation without poisoning live Q', async () => {
  let release!: () => void, entered!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  let preparations = 0
  let lockParents = 0,
    queued!: () => void
  const joined = new Promise<void>((resolve) => {
    queued = resolve
  })
  seam.after = async (method, path) => {
    if (method === 'mkdir' && path === join(storage(), 'lock') && ++lockParents === 2) {
      queued()
    }
  }
  seam.before = async (method, path) => {
    if (method === 'readdir' && path === join(storage(), 'lock')) {
      preparations++
      entered()
      await blocked
    }
  }
  const p = install('P')
  let q: ReturnType<typeof install> | undefined
  try {
    await ready
    q = install('Q')
    await joined
    await new Promise((resolve) => setImmediate(resolve))
    release()
    const results = await Promise.all([p, q])
    expect(results.map((entry) => entry.state)).toEqual(['error', 'installed'])
    expect(preparations).toBe(1)
    await expect(fs.readFile(file('P'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await read(file('Q'))).statusLine).toBeDefined()
  } finally {
    release()
    await Promise.allSettled([p, q])
    seam.before = seam.after = null
  }
  expect((await install('P')).state).toBe('installed')
})

it('publishes safe existing events when the actual parent stat has zero identity', async () => {
  await write(file('zero'), {})
  seam.zeroParent = dirname(file('zero'))
  const result = await install('zero')
  expect(result.state).toBe('error')
  expect(result.managedHooksPresent).toBe(true)
  expect((await read(file('zero'))).statusLine).toBeUndefined()
  expect((await read(file('zero'))).hooks.SessionStart).toHaveLength(1)
  expect((await remove('zero')).state).toBe('error')
  expect((await read(file('zero'))).hooks.SessionStart).toBeUndefined()
})

it('leaves unrelated managed and own-change destinations uninspected until explicitly selected', async () => {
  await install('X')
  await install('A')
  seam.after = async (method, path) => {
    if (method === 'rename' && path === file('A') && !(await read(file('A'))).statusLine) {
      throw failure()
    }
  }
  expect((await install('A', { claudeVersion: '1.0.0' })).state).toBe('error')
  seam.after = null
  let forbidden = 0
  seam.before = async (method, path) => {
    if (
      ['readFile', 'stat', 'lstat', 'realpath'].includes(method) &&
      [file('X'), file('A'), dirname(file('X')), dirname(file('A'))].includes(path)
    ) {
      forbidden++
      throw failure()
    }
  }
  const results = await applyAgentStatusHooksEnabled(true, null, {
    agents: ['claude', 'gemini'],
    env: { CLAUDE_CONFIG_DIR: dirname(file('Z')) }
  })
  expect(results.map((entry) => entry.state)).toEqual(['installed', 'installed'])
  expect(forbidden).toBe(0)
  expect((await read(file('Z'))).statusLine).toBeDefined()
  expect(
    (await document()).destinations.find((entry: { path: string }) => entry.path === file('A'))
      .phase
  ).toBe('own-change')
  seam.before = null
  expect((await install('A')).state).toBe('installed')
  expect((await read(file('A'))).statusLine).toBeDefined()
  expect(
    (await document()).destinations.find((entry: { path: string }) => entry.path === file('A'))
      .phase
  ).toBe('managed')
})

it('keeps exact conventional no-op off bytes and backups while resetting only current and conventional records', async () => {
  await install('X')
  await install('unrelated')
  await erase('unrelated')
  await write(file('.claude'), { model: 'opus' })
  const raw = '{"model":"opus"}'
  await fs.writeFile(file('.claude'), raw)
  const backup = `${file('.claude')}.bak`
  for (const savedBackup of [null, 'keep this backup']) {
    if (savedBackup !== null) {
      await fs.writeFile(backup, savedBackup)
    }
    expect((await remove('X')).state).toBe('not_installed')
    expect(await fs.readFile(file('.claude'), 'utf8')).toBe(raw)
    if (savedBackup === null) {
      await expect(fs.readFile(backup)).rejects.toMatchObject({ code: 'ENOENT' })
    } else {
      expect(await fs.readFile(backup, 'utf8')).toBe(savedBackup)
    }
    expect((await document()).destinations).toHaveLength(1)
    expect((await document()).destinations[0].path).toBe(file('unrelated'))
    await install('X')
  }
  await fs.unlink(file('.claude'))
  expect((await remove('X')).state).toBe('not_installed')
  await expect(fs.readFile(file('.claude'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await install('unrelated')).state).toBe('installed')
  expect((await read(file('unrelated'))).statusLine).toBeUndefined()
})

it('joins an admitted receipt mutation through completion when canceled and never releases a live writer', async () => {
  await install('seed')
  const meta = await documentPath()
  let entered!: () => void, release!: () => void
  const ready = new Promise<void>((resolve) => {
    entered = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  seam.after = async (method, path) => {
    if (method === 'rename' && path === meta) {
      entered()
      await blocked
    }
  }
  const controller = new AbortController()
  let settled = false
  const pending = service()
    .installSystem({
      ...current,
      target: { kind: 'system-default', configDir: dirname(file('X')) },
      signal: controller.signal
    })
    .then((result) => {
      settled = true
      return result
    })
  await ready
  controller.abort()
  await new Promise((resolve) => setImmediate(resolve))
  expect(settled).toBe(false)
  expect((await remove('X')).state).toBe('error')
  expect((await read(file('X'))).statusLine).toBeDefined()
  seam.after = null
  release()
  expect((await pending).managedHooksPresent).toBe(true)
  expect(
    (await document()).destinations.some((entry: { path: string }) => entry.path === file('X'))
  ).toBe(true)
  expect((await remove('X')).state).toBe('not_installed')
  expect((await read(file('X'))).statusLine).toBeUndefined()
})

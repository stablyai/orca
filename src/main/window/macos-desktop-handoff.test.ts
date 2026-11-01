import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { skillShareIdFromArguments } from '../../shared/skill-share-link'

const { spawnProcessMock } = vi.hoisted(() => ({ spawnProcessMock: vi.fn() }))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/Applications/Orca.app/Contents/MacOS/Orca',
    dock: { hide: vi.fn() },
    setActivationPolicy: vi.fn()
  }
}))
vi.mock('@orca/process-host', () => ({ spawnProcess: spawnProcessMock }))

const { createDesktopHandoff, desktopHandoffArguments, handOffToDesktopApp } =
  await import('./macos-desktop-handoff')

function makeChild(): EventEmitter & { unref: ReturnType<typeof vi.fn> } {
  return Object.assign(new EventEmitter(), { unref: vi.fn() })
}

afterEach(() => {
  spawnProcessMock.mockReset()
  vi.restoreAllMocks()
})

describe('handOffToDesktopApp', () => {
  it('opens a new instance of the installed bundle with a Dock launch environment', () => {
    const child = makeChild()
    spawnProcessMock.mockReturnValue(child)

    handOffToDesktopApp([], {
      platform: 'darwin',
      env: {},
      reapplyActivationPolicy: vi.fn()
    })

    expect(spawnProcessMock).toHaveBeenCalledWith({
      program: '/usr/bin/open',
      args: ['-n', '/Applications/Orca.app'],
      env: {},
      detached: true,
      stdio: 'ignore'
    })
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('passes buffered links and documents to the new instance', () => {
    spawnProcessMock.mockReturnValue(makeChild())

    handOffToDesktopApp(['orca://skills/share/abc', '/Users/me/notes.md'], {
      platform: 'darwin',
      env: {},
      executablePath: '/Users/me/Applications/Orca.app/Contents/MacOS/Orca',
      reapplyActivationPolicy: vi.fn()
    })

    expect(spawnProcessMock.mock.calls[0][0].args).toEqual([
      '-n',
      '/Users/me/Applications/Orca.app',
      '--args',
      'orca://skills/share/abc',
      '/Users/me/notes.md'
    ])
  })

  it('drops back out of the Dock after launching the desktop app', () => {
    spawnProcessMock.mockReturnValue(makeChild())
    const reapplyActivationPolicy = vi.fn()

    handOffToDesktopApp([], {
      platform: 'darwin',
      env: {},
      reapplyActivationPolicy
    })

    expect(reapplyActivationPolicy).toHaveBeenCalledOnce()
    expect(reapplyActivationPolicy.mock.invocationCallOrder[0]).toBeGreaterThan(
      spawnProcessMock.mock.invocationCallOrder[0]
    )
  })

  it('logs a failed launch instead of taking main down', () => {
    const child = makeChild()
    spawnProcessMock.mockReturnValue(child)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    handOffToDesktopApp([], {
      platform: 'darwin',
      env: {},
      reapplyActivationPolicy: vi.fn()
    })
    child.emit('error', new Error('spawn /usr/bin/open ENOENT'))

    expect(warn).toHaveBeenCalledOnce()
  })

  it.each([{ ORCA_BACKGROUND_LAUNCH: '1' }, { ORCA_E2E_USER_DATA_DIR: '/tmp/e2e' }])(
    'never launches the real desktop app from an automated sidecar (%o)',
    (env) => {
      const reapplyActivationPolicy = vi.fn()

      handOffToDesktopApp([], {
        platform: 'darwin',
        env,
        reapplyActivationPolicy
      })

      expect(spawnProcessMock).not.toHaveBeenCalled()
      expect(reapplyActivationPolicy).toHaveBeenCalledOnce()
    }
  )

  it('does nothing off macOS', () => {
    const reapplyActivationPolicy = vi.fn()

    handOffToDesktopApp([], { platform: 'linux', reapplyActivationPolicy })

    expect(spawnProcessMock).not.toHaveBeenCalled()
    expect(reapplyActivationPolicy).not.toHaveBeenCalled()
  })
})

describe('createDesktopHandoff', () => {
  const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

  it('hands a multi-file open over in one launch carrying every file', async () => {
    const pending: string[] = []
    const handOff = vi.fn()
    const requestHandoff = createDesktopHandoff({
      drainArguments: () => pending.splice(0),
      handOff
    })

    for (const file of ['/Users/me/a.md', '/Users/me/b.md', '/Users/me/c.csv']) {
      pending.push(file)
      requestHandoff()
    }
    expect(handOff).not.toHaveBeenCalled()
    await nextTurn()

    expect(handOff).toHaveBeenCalledOnce()
    expect(handOff).toHaveBeenCalledWith(['/Users/me/a.md', '/Users/me/b.md', '/Users/me/c.csv'])
  })

  it('launches again for a later open', async () => {
    const handOff = vi.fn()
    const requestHandoff = createDesktopHandoff({
      drainArguments: () => [],
      handOff
    })

    requestHandoff()
    await nextTurn()
    requestHandoff()
    await nextTurn()

    expect(handOff).toHaveBeenCalledTimes(2)
  })
})

describe('desktopHandoffArguments', () => {
  it('turns the buffered share id into a link the desktop app reads from argv', () => {
    const args = desktopHandoffArguments({
      skillShareDeepLinks: { consume: () => 'abc_123' },
      pluginInstallLinks: { consume: () => 'orca://plugins/acme.dusk?catalog=community' },
      osOpenedDocuments: { consume: () => ['/Users/me/notes.md'] }
    })

    expect(args).toEqual([
      'orca://skills/share/abc_123',
      'orca://plugins/acme.dusk?catalog=community',
      '/Users/me/notes.md'
    ])
    expect(skillShareIdFromArguments(args)).toBe('abc_123')
  })

  it('is empty for a plain app open', () => {
    expect(
      desktopHandoffArguments({
        skillShareDeepLinks: { consume: () => null },
        pluginInstallLinks: { consume: () => null },
        osOpenedDocuments: { consume: () => [] }
      })
    ).toEqual([])
  })
})

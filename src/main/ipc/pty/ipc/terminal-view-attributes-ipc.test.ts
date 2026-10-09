import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { TerminalOscColorQueryReplyColors } from '../../../../shared/terminal-osc-color-reply'
import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import {
  _resetTerminalViewAttributesForTest,
  getTerminalViewAttributes,
  getTerminalViewAttributesForScope,
  getTerminalViewerColors,
  registerTerminalViewAttributesApplier,
  setPairedViewerColors,
  setRepoTerminalViewAttributes,
  setTerminalViewAttributes,
  setTerminalViewerColorsListener
} from '../../../runtime/terminal-view-attribute-store'
import { HeadlessEmulator } from '../../../daemon/headless-emulator'
import {
  resolveTerminalViewAttributes,
  type TerminalViewAttributesRepo
} from '../../../../shared/terminal-view-attributes-composition'
import { resolveRepoTerminalViewAttributesByHost } from '../../../../shared/repo-terminal-view-attributes-by-host'
import type { PtyOwnerRepoColors } from '../../../../shared/pty-owner-color-query-colors'
import type { TerminalViewAttributes } from '../../../../shared/terminal-view-attributes'
import {
  _resetColorQueryReplyColorsForTest,
  getLocalPtyProvider,
  registerSshPtyProvider,
  setLocalPtyProvider,
  unregisterSshPtyProvider
} from '../provider/registry'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'
import {
  installTerminalViewAttributesIpc,
  type TerminalViewAttributesSeedStore
} from './terminal-view-attributes-ipc'

class RecordingProvider extends LocalPtyProvider {
  readonly pushes: TerminalOscColorQueryReplyColors[] = []

  override setColorQueryReplyColors(colors: TerminalOscColorQueryReplyColors): void {
    this.pushes.push(colors)
  }
}

const DESKTOP_ATTRIBUTES: TerminalViewAttributes = {
  foreground: [0, 0, 0],
  background: [0x12, 0x34, 0x56],
  cursor: [0, 0, 0],
  ansi: Array.from({ length: 256 }, (): [number, number, number] => [0, 0, 0]),
  colorSchemeMode: 'light',
  cursorStyle: 'block',
  cursorBlink: false
}
const DESKTOP = { foreground: '#000000', background: '#123456' }
const CLIENT = { foreground: '#2e3434', background: '#ffffff' }

describe('seeding PTY owner colours from saved settings', () => {
  const originalLocal = getLocalPtyProvider()
  const settings = getDefaultSettings('/tmp')

  afterEach(() => {
    _resetTerminalViewAttributesForTest()
    _resetColorQueryReplyColorsForTest()
    setLocalPtyProvider(originalLocal)
  })

  it('seeds a light-appearance host with its light theme before any renderer push', () => {
    const owner = new RecordingProvider()
    setLocalPtyProvider(owner)

    installTerminalViewAttributesIpc({
      getSettings: () => ({ ...settings, theme: 'system' }),
      options: { systemPrefersDark: () => false }
    })

    expect(owner.pushes).toEqual([{ foreground: '#2e3434', background: '#ffffff' }])
  })

  it('seeds a host with no display from its saved dark theme', () => {
    const owner = new RecordingProvider()
    setLocalPtyProvider(owner)

    installTerminalViewAttributesIpc({ getSettings: () => ({ ...settings, theme: 'dark' }) })

    expect(owner.pushes).toEqual([{ foreground: '#ffffff', background: '#282c34' }])
  })

  it('publishes colours a renderer already pushed instead of the saved theme', () => {
    setTerminalViewAttributes(DESKTOP_ATTRIBUTES)
    const owner = new RecordingProvider()
    setLocalPtyProvider(owner)

    installTerminalViewAttributesIpc({ getSettings: () => settings })

    expect(owner.pushes).toEqual([DESKTOP])
  })
})

describe('one viewer colour value for every PTY owner', () => {
  const originalLocal = getLocalPtyProvider()
  const settings = getDefaultSettings('/tmp')
  const SEED = { foreground: '#ffffff', background: '#282c34' }

  afterEach(() => {
    _resetTerminalViewAttributesForTest()
    _resetColorQueryReplyColorsForTest()
    setLocalPtyProvider(originalLocal)
  })

  function install(): RecordingProvider {
    const owner = new RecordingProvider()
    setLocalPtyProvider(owner)
    installTerminalViewAttributesIpc({ getSettings: () => ({ ...settings, theme: 'dark' }) })
    return owner
  }

  it("keeps this host's own window theme when a paired client pushes", () => {
    const owner = install()
    setTerminalViewAttributes(DESKTOP_ATTRIBUTES)

    setPairedViewerColors(CLIENT)

    expect(getTerminalViewerColors()).toEqual(DESKTOP)
    expect(owner.pushes).toEqual([SEED, DESKTOP])
    expect(getTerminalViewAttributes()).toBe(DESKTOP_ATTRIBUTES)
  })

  it("answers with a paired client's theme on a host with no window of its own", () => {
    const owner = install()

    setPairedViewerColors(CLIENT)

    expect(getTerminalViewerColors()).toEqual(CLIENT)
    expect(owner.pushes).toEqual([SEED, CLIENT])
  })

  it("switches to this host's window theme once its renderer pushes", () => {
    const owner = install()
    setPairedViewerColors(CLIENT)

    setTerminalViewAttributes(DESKTOP_ATTRIBUTES)
    setPairedViewerColors({ foreground: '#111111', background: '#eeeeee' })

    expect(getTerminalViewerColors()).toEqual(DESKTOP)
    expect(owner.pushes).toEqual([SEED, CLIENT, DESKTOP])
  })

  it('falls back to the saved theme until any viewer reports', () => {
    const owner = install()

    expect(getTerminalViewerColors()).toEqual(SEED)
    expect(owner.pushes).toEqual([SEED])
  })

  it('notifies once per change of the answered colours', () => {
    install()
    const published: unknown[] = []
    setTerminalViewerColorsListener((colors) => published.push(colors))

    setPairedViewerColors(CLIENT)
    setPairedViewerColors({ ...CLIENT })
    setTerminalViewAttributes(DESKTOP_ATTRIBUTES)
    setTerminalViewAttributes({ ...DESKTOP_ATTRIBUTES, cursorBlink: true })
    setPairedViewerColors({ foreground: '#111111', background: '#eeeeee' })

    expect(published).toEqual([CLIENT, DESKTOP])
  })
})

describe('project colours for the local PTY owner', () => {
  const originalLocal = getLocalPtyProvider()
  const settings = getDefaultSettings('/tmp')
  const SOLARIZED_ATTRIBUTES: TerminalViewAttributes = {
    ...DESKTOP_ATTRIBUTES,
    foreground: [0x83, 0x94, 0x96],
    background: [0x00, 0x2b, 0x36]
  }
  const SOLARIZED = { foreground: '#839496', background: '#002b36' }

  class ProjectRecordingProvider extends LocalPtyProvider {
    readonly projectPushes: (PtyOwnerRepoColors | undefined)[] = []

    override setColorQueryReplyColors(
      _colors: TerminalOscColorQueryReplyColors,
      byRepoId?: PtyOwnerRepoColors
    ): void {
      this.projectPushes.push(byRepoId)
    }
  }

  afterEach(() => {
    _resetTerminalViewAttributesForTest()
    _resetColorQueryReplyColorsForTest()
    setLocalPtyProvider(originalLocal)
  })

  it('withholds the project map until the first renderer push, then forwards each change', () => {
    const owner = new ProjectRecordingProvider()
    setLocalPtyProvider(owner)
    installTerminalViewAttributesIpc({ getSettings: () => ({ ...settings, theme: 'dark' }) })

    // Why the empty map is sent: it clears projects a surviving daemon still themes.
    setRepoTerminalViewAttributes({ byHostId: {} })
    setRepoTerminalViewAttributes({ byHostId: { local: { 'repo-a': SOLARIZED_ATTRIBUTES } } })
    // Cursor-only change: the colours the owner answers with are unchanged.
    setRepoTerminalViewAttributes({
      byHostId: { local: { 'repo-a': { ...SOLARIZED_ATTRIBUTES, cursorBlink: true } } }
    })

    expect(owner.projectPushes).toEqual([undefined, {}, { 'repo-a': SOLARIZED }])
  })

  it('seeds themed local projects from persisted repos before any renderer push', () => {
    const owner = new ProjectRecordingProvider()
    setLocalPtyProvider(owner)
    const repos = [
      { id: 'repo-a', connectionId: null, terminalTheme: { dark: 'Solarized Dark' } },
      { id: 'repo-b', connectionId: null },
      { id: 'repo-c', connectionId: 'ssh-1', terminalTheme: { dark: 'Solarized Dark' } }
    ]
    const settingsListeners: (() => void)[] = []
    const clientEventListeners: ((event: RuntimeClientEvent) => void)[] = []
    let current = { ...settings, theme: 'dark' as const }
    const store: TerminalViewAttributesSeedStore = {
      getRepos: () => repos,
      onSettingsChanged: (next) => {
        settingsListeners.push(() => next({}, current))
        return () => {}
      }
    }
    const runtime = {
      onClientEvent: (listener: (event: RuntimeClientEvent) => void) => {
        clientEventListeners.push(listener)
        return () => {}
      }
    }

    installTerminalViewAttributesIpc({
      getSettings: () => current,
      options: {},
      mainWindow: {},
      store,
      runtime
    })
    expect(owner.projectPushes).toEqual([{ 'repo-a': SOLARIZED }])
    expect(getTerminalViewerColors({ worktreeId: 'repo-a::/a', connectionId: null })).toEqual(
      SOLARIZED
    )
    // The SSH project is seeded too, under its own host; the local owner never hears of it.
    expect(getTerminalViewerColors({ worktreeId: 'repo-c::/c', connectionId: 'ssh-1' })).toEqual(
      SOLARIZED
    )

    // A settings change re-seeds: a global colour override reaches the project's pane too.
    current = { ...current, terminalColorOverrides: { background: '#101010' } }
    settingsListeners.forEach((notify) => notify())
    expect(owner.projectPushes.at(-1)).toEqual({
      'repo-a': { foreground: '#839496', background: '#101010' }
    })

    // A repo change (window IPC or a paired client's RPC) re-reads the persisted projects.
    repos[0] = { id: 'repo-a', connectionId: null, terminalTheme: { dark: 'Tokyo Night' } }
    clientEventListeners.forEach((notify) => notify({ type: 'reposChanged' }))
    expect(owner.projectPushes.at(-1)).toEqual({
      'repo-a': { foreground: '#c0caf5', background: '#101010' }
    })
    current = { ...current, terminalColorOverrides: {} }
    settingsListeners.forEach((notify) => notify())

    // The renderer's publish of the same values is not a change the owner hears about again.
    const pushesBefore = owner.projectPushes.length
    setRepoTerminalViewAttributes({
      byHostId: {
        local: {
          'repo-a': {
            ...SOLARIZED_ATTRIBUTES,
            foreground: [0xc0, 0xca, 0xf5],
            background: [0x1a, 0x1b, 0x26]
          }
        }
      }
    })
    expect(owner.projectPushes.length).toBe(pushesBefore)
  })

  it('does not seed project colours on a host with no window of its own', () => {
    // Paired clients paint a headless host's projects with their own global theme.
    const owner = new ProjectRecordingProvider()
    setLocalPtyProvider(owner)
    const store: TerminalViewAttributesSeedStore = {
      getRepos: () => [
        { id: 'repo-a', connectionId: null, terminalTheme: { dark: 'Solarized Dark' } }
      ]
    }

    installTerminalViewAttributesIpc({ getSettings: () => ({ ...settings, theme: 'dark' }), store })

    expect(owner.projectPushes).toEqual([undefined])
    expect(getTerminalViewerColors({ worktreeId: 'repo-a::/a', connectionId: null })).toEqual({
      foreground: '#ffffff',
      background: '#282c34'
    })
  })

  it('re-seeds when the OS appearance flips under a system theme', () => {
    const owner = new ProjectRecordingProvider()
    setLocalPtyProvider(owner)
    let prefersDark = true
    const appearanceListeners: (() => void)[] = []
    const store: TerminalViewAttributesSeedStore = {
      getRepos: () => [
        {
          id: 'repo-a',
          connectionId: null,
          terminalTheme: { dark: 'Solarized Dark', light: 'Solarized Light' }
        }
      ]
    }

    installTerminalViewAttributesIpc({
      getSettings: () => ({ ...settings, theme: 'system' }),
      options: {
        systemPrefersDark: () => prefersDark,
        onSystemAppearanceChanged: (listener) => {
          appearanceListeners.push(listener)
          return () => {}
        }
      },
      mainWindow: {},
      store
    })
    expect(owner.projectPushes.at(-1)).toEqual({ 'repo-a': SOLARIZED })

    prefersDark = false
    appearanceListeners.forEach((notify) => notify())

    expect(owner.projectPushes.at(-1)).toEqual({
      'repo-a': { foreground: '#657b83', background: '#fdf6e3' }
    })
  })

  it('republishes the known project map when the IPC layer re-installs', () => {
    setRepoTerminalViewAttributes({ byHostId: { local: { 'repo-a': SOLARIZED_ATTRIBUTES } } })
    const owner = new ProjectRecordingProvider()
    setLocalPtyProvider(owner)

    installTerminalViewAttributesIpc({ getSettings: () => ({ ...settings, theme: 'dark' }) })

    expect(owner.projectPushes.at(-1)).toEqual({ 'repo-a': SOLARIZED })
  })
})

describe('attributes pre-loaded for the hidden responder', () => {
  const originalLocal = getLocalPtyProvider()
  const settings = getDefaultSettings('/tmp')
  const REPOS: TerminalViewAttributesSeedStore['getRepos'] = () => [
    { id: 'repo-a', connectionId: null, terminalTheme: { dark: 'Solarized Dark' } },
    { id: 'repo-b', connectionId: null }
  ]
  const themed = { worktreeId: 'repo-a::/a', connectionId: null }
  const unthemed = { worktreeId: 'repo-b::/b', connectionId: null }

  afterEach(() => {
    _resetTerminalViewAttributesForTest()
    _resetColorQueryReplyColorsForTest()
    setLocalPtyProvider(originalLocal)
  })

  // A hidden PTY's model, wired the way the runtime wires it: the scope resolves at query time.
  function hiddenModel(scope: { worktreeId: string; connectionId: null }): {
    emulator: HeadlessEmulator
    replies: string[]
  } {
    const replies: string[] = []
    const emulator = new HeadlessEmulator({
      cols: 80,
      rows: 24,
      onQueryReply: (reply) => replies.push(reply)
    })
    emulator.installViewAttributeResponder(() => getTerminalViewAttributesForScope(scope))
    return { emulator, replies }
  }
  const PROBE = '\x1b]4;1;?\x07\x1b]12;?\x07\x1b[?996n'

  it("answers OSC 4/12 and ?996n from the project's and the global saved theme before any renderer publish", async () => {
    setLocalPtyProvider(new RecordingProvider())
    let current = { ...settings, theme: 'dark' as const }
    const settingsListeners: (() => void)[] = []
    installTerminalViewAttributesIpc({
      getSettings: () => current,
      options: {},
      mainWindow: {},
      store: {
        getRepos: REPOS,
        onSettingsChanged: (next) => {
          settingsListeners.push(() => next({}, current))
          return () => {}
        }
      }
    })
    const projectModel = hiddenModel(themed)
    const globalModel = hiddenModel(unthemed)

    await projectModel.emulator.write(PROBE, { forwardQueryReplies: true })
    await globalModel.emulator.write(PROBE, { forwardQueryReplies: true })

    // Solarized Dark red/cursor; Ghostty Default Style Dark red/cursor. Both dark.
    expect(projectModel.replies).toEqual([
      '\x1b]4;1;rgb:dcdc/3232/2f2f\x1b\\',
      '\x1b]12;rgb:8383/9494/9696\x1b\\',
      '\x1b[?997;1n'
    ])
    expect(globalModel.replies).toEqual([
      '\x1b]4;1;rgb:cccc/6666/6666\x1b\\',
      '\x1b]12;rgb:ffff/ffff/ffff\x1b\\',
      '\x1b[?997;1n'
    ])
    expect(getTerminalViewAttributesForScope(themed)).toEqual(
      resolveTerminalViewAttributes({ ...current, terminalThemeDark: 'Solarized Dark' }, true)
    )
    expect(getTerminalViewAttributesForScope(unthemed)).toEqual(
      resolveTerminalViewAttributes(current, true)
    )

    // A settings change re-seeds the attributes the renderer has not published yet.
    current = { ...current, terminalCursorBlink: true, terminalCursorStyle: 'bar' }
    settingsListeners.forEach((notify) => notify())
    expect(getTerminalViewAttributesForScope(themed)).toMatchObject({
      cursorBlink: true,
      cursorStyle: 'bar'
    })
  })

  it("keeps a TUI's OSC SET overlays when the renderer publishes what main pre-loaded", async () => {
    setLocalPtyProvider(new RecordingProvider())
    const current = { ...settings, theme: 'dark' as const }
    installTerminalViewAttributesIpc({
      getSettings: () => current,
      options: {},
      mainWindow: {},
      store: { getRepos: REPOS }
    })
    const model = hiddenModel(themed)
    await model.emulator.write('\x1b]4;1;#00ff00\x07', { forwardQueryReplies: true })
    // The runtime's applier, for this one model.
    registerTerminalViewAttributesApplier((push) => {
      const attributes = getTerminalViewAttributesForScope(themed)
      if (attributes) {
        model.emulator.applyPushedViewAttributes(
          attributes,
          push.kind === 'theme-change' ? push.resolveBefore(themed) : null
        )
      }
    })

    // The renderer's publishes, composed from the same settings and projects.
    setTerminalViewAttributes(resolveTerminalViewAttributes(current, true))
    setRepoTerminalViewAttributes({
      byHostId: resolveRepoTerminalViewAttributesByHost(current, REPOS(), true)
    })
    await model.emulator.write('\x1b]4;1;?\x07', { forwardQueryReplies: true })

    expect(model.replies).toEqual(['\x1b]4;1;rgb:0000/ffff/0000\x1b\\'])
  })

  it('stays silent on a host with no window of its own', async () => {
    setLocalPtyProvider(new RecordingProvider())
    installTerminalViewAttributesIpc({
      getSettings: () => ({ ...settings, theme: 'dark' }),
      store: { getRepos: REPOS }
    })
    const model = hiddenModel(themed)

    await model.emulator.write(PROBE, { forwardQueryReplies: true })

    expect(model.replies).toEqual([])
    expect(getTerminalViewAttributesForScope(themed)).toBeNull()
  })
})

describe('project colours for SSH PTY owners', () => {
  const originalLocal = getLocalPtyProvider()
  const settings = getDefaultSettings('/tmp')
  const SOLARIZED = { foreground: '#839496', background: '#002b36' }
  const TOKYO = { foreground: '#c0caf5', background: '#1a1b26' }

  class OwnerRecordingProvider extends LocalPtyProvider {
    readonly pushes: { colors: TerminalOscColorQueryReplyColors; byRepoId?: PtyOwnerRepoColors }[] =
      []

    override setColorQueryReplyColors(
      colors: TerminalOscColorQueryReplyColors,
      byRepoId?: PtyOwnerRepoColors
    ): void {
      this.pushes.push({ colors, byRepoId })
    }
  }

  afterEach(() => {
    _resetTerminalViewAttributesForTest()
    _resetColorQueryReplyColorsForTest()
    for (const connectionId of ['ssh-1', 'ssh-2', 'ssh-3']) {
      unregisterSshPtyProvider(connectionId)
    }
    setLocalPtyProvider(originalLocal)
  })

  it("seeds each SSH relay with its own host's projects, and a hidden SSH PTY answers from them", async () => {
    const local = new OwnerRecordingProvider()
    setLocalPtyProvider(local)
    const relay1 = new OwnerRecordingProvider()
    const relay2 = new OwnerRecordingProvider()
    registerSshPtyProvider('ssh-1', relay1)
    registerSshPtyProvider('ssh-2', relay2)
    const repos: TerminalViewAttributesRepo[] = [
      { id: 'repo-a', connectionId: null, terminalTheme: { dark: 'Solarized Dark' } },
      // The same repo id on an SSH host, themed differently there.
      { id: 'repo-a', executionHostId: 'ssh:ssh-1', terminalTheme: { dark: 'Tokyo Night' } },
      { id: 'repo-c', connectionId: 'ssh-1', terminalTheme: { dark: 'Solarized Dark' } },
      { id: 'repo-d', connectionId: 'ssh-2' },
      { id: 'repo-e', executionHostId: 'runtime:r1', terminalTheme: { dark: 'Solarized Dark' } }
    ]
    const clientEventListeners: ((event: RuntimeClientEvent) => void)[] = []

    installTerminalViewAttributesIpc({
      getSettings: () => ({ ...settings, theme: 'dark' }),
      options: {},
      mainWindow: {},
      store: { getRepos: () => repos },
      runtime: {
        onClientEvent: (listener) => {
          clientEventListeners.push(listener)
          return () => {}
        }
      }
    })

    expect(local.pushes.map((push) => push.byRepoId)).toEqual([{ 'repo-a': SOLARIZED }])
    expect(relay1.pushes.map((push) => push.byRepoId)).toEqual([
      { 'repo-a': TOKYO, 'repo-c': SOLARIZED }
    ])
    // Known to have no themed project: an empty map, so a surviving relay clears its old one.
    expect(relay2.pushes.map((push) => push.byRepoId)).toEqual([{}])
    // A relay that registers (or reconnects) later hears its slice at once.
    const relay3 = new OwnerRecordingProvider()
    registerSshPtyProvider('ssh-3', relay3)
    expect(relay3.pushes.map((push) => push.byRepoId)).toEqual([{}])

    const sshScope = { worktreeId: 'repo-a::/remote/a', connectionId: 'ssh-1' }
    expect(getTerminalViewerColors(sshScope)).toEqual(TOKYO)
    expect(getTerminalViewerColors({ worktreeId: 'repo-a::/a', connectionId: null })).toEqual(
      SOLARIZED
    )
    // Main's hidden responder for the SSH PTY: OSC 4;1 is Tokyo Night red, not Solarized's.
    const replies: string[] = []
    const emulator = new HeadlessEmulator({
      cols: 80,
      rows: 24,
      onQueryReply: (reply) => replies.push(reply)
    })
    emulator.installViewAttributeResponder(() => getTerminalViewAttributesForScope(sshScope))
    await emulator.write('\x1b]4;1;?\x07\x1b[?996n', { forwardQueryReplies: true })
    expect(replies).toEqual(['\x1b]4;1;rgb:f7f7/7676/8e8e\x1b\\', '\x1b[?997;1n'])

    // A change on one SSH host reaches that relay only.
    repos[2] = { id: 'repo-c', connectionId: 'ssh-1', terminalTheme: { dark: 'Tokyo Night' } }
    clientEventListeners.forEach((notify) => notify({ type: 'reposChanged' }))
    expect(relay1.pushes.map((push) => push.byRepoId)).toEqual([
      { 'repo-a': TOKYO, 'repo-c': SOLARIZED },
      { 'repo-a': TOKYO, 'repo-c': TOKYO }
    ])
    expect(local.pushes).toHaveLength(1)
    expect(relay2.pushes).toHaveLength(1)
  })

  it('never sends a relay a project map main does not know (headless host)', () => {
    const relay = new OwnerRecordingProvider()
    installTerminalViewAttributesIpc({
      getSettings: () => ({ ...settings, theme: 'dark' }),
      store: {
        getRepos: () => [
          { id: 'repo-c', connectionId: 'ssh-1', terminalTheme: { dark: 'Solarized Dark' } }
        ]
      }
    })
    registerSshPtyProvider('ssh-1', relay)

    expect(relay.pushes).toEqual([{ colors: { foreground: '#ffffff', background: '#282c34' } }])
    expect(relay.pushes[0]).not.toHaveProperty('byRepoId', expect.anything())
  })
})

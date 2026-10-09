import { afterEach, describe, expect, it } from 'vitest'
import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import type { TerminalOscColorQueryReplyColors } from '../../../../shared/terminal-osc-color-reply'
import type { PtyOwnerRepoColors } from '../../../../shared/pty-owner-color-query-colors'
import {
  _resetColorQueryReplyColorsForTest,
  getLocalPtyProvider,
  publishColorQueryReplyColors,
  publishRepoColorQueryReplyColors,
  registerSshPtyProvider,
  setLocalPtyProvider,
  unregisterSshPtyProvider
} from './registry'

class RecordingProvider extends LocalPtyProvider {
  readonly pushes: TerminalOscColorQueryReplyColors[] = []
  readonly projectPushes: (PtyOwnerRepoColors | undefined)[] = []

  override setColorQueryReplyColors(
    colors: TerminalOscColorQueryReplyColors,
    byRepoId?: PtyOwnerRepoColors
  ): void {
    this.pushes.push(colors)
    this.projectPushes.push(byRepoId)
  }
}

const DARK = { foreground: '#ffffff', background: '#000000' }
const LIGHT = { foreground: '#000000', background: '#ffffff' }
const SOLARIZED = { foreground: '#839496', background: '#002b36' }

describe('PTY owner colour publication', () => {
  const originalLocal = getLocalPtyProvider()

  afterEach(() => {
    _resetColorQueryReplyColorsForTest()
    unregisterSshPtyProvider('ssh-colors')
    unregisterSshPtyProvider('ssh-other')
    setLocalPtyProvider(originalLocal)
  })

  it('pushes every change to each owner, and the latest to owners that register later', () => {
    const local = new RecordingProvider()
    setLocalPtyProvider(local)
    const early = new RecordingProvider()
    registerSshPtyProvider('ssh-colors', early)
    // Why nothing yet: pushing "unknown" would wipe the theme a surviving daemon still holds.
    expect([...local.pushes, ...early.pushes]).toEqual([])

    publishColorQueryReplyColors(DARK)
    publishColorQueryReplyColors(LIGHT)
    const late = new RecordingProvider()
    registerSshPtyProvider('ssh-colors', late)

    expect(local.pushes).toEqual([DARK, LIGHT])
    expect(early.pushes).toEqual([DARK, LIGHT])
    expect(late.pushes).toEqual([LIGHT])
  })

  it('does not re-push colours every owner already has', () => {
    const local = new RecordingProvider()
    setLocalPtyProvider(local)

    publishColorQueryReplyColors(DARK)
    publishColorQueryReplyColors({ ...DARK })

    expect(local.pushes).toEqual([DARK])
  })

  it("sends each owner only its own host's projects, again to a replacement owner", () => {
    const local = new RecordingProvider()
    setLocalPtyProvider(local)
    const relay = new RecordingProvider()
    registerSshPtyProvider('ssh-colors', relay)
    // The same repo id, themed on this host and on the relay's host.
    const projects = { local: { 'repo-a': LIGHT }, 'ssh:ssh-colors': { 'repo-a': SOLARIZED } }

    publishColorQueryReplyColors(DARK)
    publishRepoColorQueryReplyColors(projects)
    publishRepoColorQueryReplyColors({
      local: { 'repo-a': { ...LIGHT } },
      'ssh:ssh-colors': { 'repo-a': { ...SOLARIZED } }
    })
    const replacementLocal = new RecordingProvider()
    setLocalPtyProvider(replacementLocal)
    const reconnectedRelay = new RecordingProvider()
    registerSshPtyProvider('ssh-colors', reconnectedRelay)

    expect(local.projectPushes).toEqual([undefined, { 'repo-a': LIGHT }])
    expect(relay.projectPushes).toEqual([undefined, { 'repo-a': SOLARIZED }])
    expect(replacementLocal.projectPushes).toEqual([{ 'repo-a': LIGHT }])
    expect(reconnectedRelay.projectPushes).toEqual([{ 'repo-a': SOLARIZED }])
  })

  it("re-pushes only the owners whose host's projects changed, and an empty map to the rest", () => {
    const local = new RecordingProvider()
    setLocalPtyProvider(local)
    const relay = new RecordingProvider()
    registerSshPtyProvider('ssh-colors', relay)
    const other = new RecordingProvider()
    registerSshPtyProvider('ssh-other', other)
    publishColorQueryReplyColors(DARK)

    publishRepoColorQueryReplyColors({ local: { 'repo-a': LIGHT } })
    publishRepoColorQueryReplyColors({
      local: { 'repo-a': LIGHT },
      'ssh:ssh-colors': { 'repo-b': SOLARIZED }
    })
    publishRepoColorQueryReplyColors({ 'ssh:ssh-colors': { 'repo-b': SOLARIZED } })
    // A host spelled with an empty map is the same as one left out.
    publishRepoColorQueryReplyColors({ local: {}, 'ssh:ssh-colors': { 'repo-b': SOLARIZED } })

    // Why {} to a host with no themed project: main knows that; the owner must clear its last map.
    expect(local.projectPushes).toEqual([undefined, { 'repo-a': LIGHT }, {}])
    expect(relay.projectPushes).toEqual([undefined, {}, { 'repo-b': SOLARIZED }])
    expect(other.projectPushes).toEqual([undefined, {}])
  })
})

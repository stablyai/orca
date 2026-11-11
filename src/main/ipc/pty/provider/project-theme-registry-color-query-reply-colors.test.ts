import { afterEach, describe, expect, it } from 'vitest'
import { LocalPtyProvider } from '../../../providers/local-pty/local-pty-provider'
import type { TerminalOscColorQueryReplyColors } from '../../../../shared/terminal/protocol/queries/terminal-osc-color-reply'
import type { PtyOwnerRepoColors } from '../../../../shared/terminal/pty/ingress/pty-owner-color-query-colors'
import {
  _resetColorQueryReplyColorsForTest,
  getLocalPtyProvider,
  publishColorQueryReplyColors,
  publishRepoColorQueryReplyColors,
  setLocalPtyProvider
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
    setLocalPtyProvider(originalLocal)
  })

  it('pushes every change to the owner, and the latest to an owner installed later', () => {
    const local = new RecordingProvider()
    setLocalPtyProvider(local)
    // Why nothing yet: pushing "unknown" would wipe the theme a surviving daemon still holds.
    expect(local.pushes).toEqual([])

    publishColorQueryReplyColors(DARK)
    publishColorQueryReplyColors(LIGHT)
    const late = new RecordingProvider()
    setLocalPtyProvider(late)

    expect(local.pushes).toEqual([DARK, LIGHT])
    expect(late.pushes).toEqual([LIGHT])
  })

  it('does not re-push colours every owner already has', () => {
    const local = new RecordingProvider()
    setLocalPtyProvider(local)

    publishColorQueryReplyColors(DARK)
    publishColorQueryReplyColors({ ...DARK })

    expect(local.pushes).toEqual([DARK])
  })

  it("sends the owner only this host's projects, again to a replacement owner", () => {
    const local = new RecordingProvider()
    setLocalPtyProvider(local)
    // The same repo id, themed on this host and on an SSH host the owner never sees.
    const projects = { local: { 'repo-a': LIGHT }, 'ssh:ssh-colors': { 'repo-a': SOLARIZED } }

    publishColorQueryReplyColors(DARK)
    publishRepoColorQueryReplyColors(projects)
    publishRepoColorQueryReplyColors({
      local: { 'repo-a': { ...LIGHT } },
      'ssh:ssh-colors': { 'repo-a': { ...SOLARIZED } }
    })
    const replacementLocal = new RecordingProvider()
    setLocalPtyProvider(replacementLocal)

    expect(local.projectPushes).toEqual([undefined, { 'repo-a': LIGHT }])
    expect(replacementLocal.projectPushes).toEqual([{ 'repo-a': LIGHT }])
  })

  it("re-pushes only when this host's projects changed, and an empty map once none is themed", () => {
    const local = new RecordingProvider()
    setLocalPtyProvider(local)
    publishColorQueryReplyColors(DARK)

    publishRepoColorQueryReplyColors({ local: { 'repo-a': LIGHT } })
    publishRepoColorQueryReplyColors({
      local: { 'repo-a': LIGHT },
      'ssh:ssh-colors': { 'repo-b': SOLARIZED }
    })
    publishRepoColorQueryReplyColors({ 'ssh:ssh-colors': { 'repo-b': SOLARIZED } })

    // Why {} once none is themed: main knows that; the owner must clear its last map.
    expect(local.projectPushes).toEqual([undefined, { 'repo-a': LIGHT }, {}])
  })
})

import { describe, expect, it } from 'vitest'
import {
  isMacosTerminalAnchorProcess,
  wrapPtySpawnInMacosTerminalAnchor
} from './macos-terminal-anchor'

const paths = { helper: '/host/orca-terminal-anchor', entry: '/host/entry.js', node: '/host/node' }
const present = { platform: 'darwin', enabled: true, paths, fileExists: () => true } as const
const env = { ORCA_WORKTREE_ID: 'repo::/w', ORCA_TERMINAL_HANDLE: 'term_1' }

describe('wrapPtySpawnInMacosTerminalAnchor', () => {
  it('runs the terminal under the anchor, naming it in the anchor argv', () => {
    expect(wrapPtySpawnInMacosTerminalAnchor('/bin/zsh', ['-l'], env, present)).toEqual({
      file: paths.helper,
      args: ['launch', paths.node, paths.entry, 'repo::/w', 'term_1', '/bin/zsh', '-l'],
      anchored: true
    })
  })

  it('still anchors a terminal that has no tag yet', () => {
    const { args } = wrapPtySpawnInMacosTerminalAnchor('/bin/zsh', [], {}, present)
    expect(args.slice(3, 6)).toEqual(['', '', '/bin/zsh'])
  })

  it('is off unless asked for', () => {
    const off = wrapPtySpawnInMacosTerminalAnchor('/bin/zsh', ['-l'], env, {
      ...present,
      enabled: false
    })
    expect(off).toEqual({ file: '/bin/zsh', args: ['-l'], anchored: false })
  })

  it.each(['linux', 'win32'] as const)('leaves %s alone', (platform) => {
    expect(
      wrapPtySpawnInMacosTerminalAnchor('/bin/zsh', [], env, { ...present, platform }).anchored
    ).toBe(false)
  })

  it.each([paths.helper, paths.entry])('degrades to no anchor without %s', (missing) => {
    const result = wrapPtySpawnInMacosTerminalAnchor('/bin/zsh', ['-l'], env, {
      ...present,
      fileExists: (path) => path !== missing
    })
    expect(result).toEqual({ file: '/bin/zsh', args: ['-l'], anchored: false })
  })
})

describe('isMacosTerminalAnchorProcess', () => {
  it('recognizes only the launcher', () => {
    expect(isMacosTerminalAnchorProcess('orca-terminal-anchor')).toBe(true)
    expect(isMacosTerminalAnchorProcess('zsh')).toBe(false)
  })
})

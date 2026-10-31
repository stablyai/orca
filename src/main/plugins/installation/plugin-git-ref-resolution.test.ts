import { describe, expect, it } from 'vitest'
import {
  newestPluginVersionTag,
  parsePluginGitRemoteRefs,
  resolvePluginGitRefFromRemote
} from './plugin-git-ref-resolution'

const sha = (digit: string): string => digit.repeat(40)

describe('plugin Git ref resolution', () => {
  it('pins annotated tags to their peeled commit', () => {
    const refs = parsePluginGitRemoteRefs(
      [
        `${sha('1')}\trefs/heads/main`,
        `${sha('2')}\trefs/tags/v0.1.0`,
        `${sha('3')}\trefs/tags/v0.1.0^{}`,
        `${sha('4')}\trefs/tags/light`,
        'not a ref line'
      ].join('\n')
    )
    expect(refs.tags).toEqual(
      new Map([
        ['v0.1.0', sha('3')],
        ['light', sha('4')]
      ])
    )
    expect(refs.branches).toEqual(new Map([['main', sha('1')]]))
  })

  it('picks the newest stable version tag, and a prerelease only without one', () => {
    expect(newestPluginVersionTag(['v0.9.0', 'v0.10.0', 'v1.0.0-beta.1', 'nightly'])).toBe(
      'v0.10.0'
    )
    expect(newestPluginVersionTag(['1.2.0', 'v1.10.0'])).toBe('v1.10.0')
    expect(newestPluginVersionTag(['v1.0.0-beta.1', 'v1.0.0-beta.2'])).toBe('v1.0.0-beta.2')
    expect(newestPluginVersionTag(['nightly', 'latest'])).toBeNull()
  })

  it('resolves an empty ref to the latest tag and names tags before branches', () => {
    const refs = {
      tags: new Map([
        ['v1.0.0', sha('a')],
        ['v1.1.0', sha('b')],
        ['main', sha('c')]
      ]),
      branches: new Map([
        ['main', sha('d')],
        ['dev', sha('e')]
      ])
    }
    expect(resolvePluginGitRefFromRemote(refs, '')).toEqual({
      kind: 'latest-tag',
      ref: 'v1.1.0',
      commit: sha('b')
    })
    expect(resolvePluginGitRefFromRemote(refs, 'main')).toEqual({
      kind: 'tag',
      ref: 'main',
      commit: sha('c')
    })
    expect(resolvePluginGitRefFromRemote(refs, 'dev')).toEqual({
      kind: 'branch',
      ref: 'dev',
      commit: sha('e')
    })
    expect(resolvePluginGitRefFromRemote(refs, 'readme')).toBeNull()
    expect(
      resolvePluginGitRefFromRemote({ tags: new Map(), branches: refs.branches }, '')
    ).toBeNull()
  })
})

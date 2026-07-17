import { describe, expect, it } from 'vitest'

import {
  parseSshRelayReleaseTag,
  sshRelayRuntimeArchiveName,
  sshRelayRuntimeDownloadUrl
} from './ssh-relay-release-asset'

const contentId = `sha256:${'a'.repeat(64)}` as const

describe('SSH relay release asset identity', () => {
  it.each([
    ['v1.2.3', 'stable'],
    ['v1.2.3-rc.4', 'rc'],
    ['v1.2.3-rc.4.perf', 'perf']
  ] as const)('accepts exact %s tags', (tag, channel) => {
    expect(parseSshRelayReleaseTag(tag).channel).toBe(channel)
  })

  it.each(['latest', 'v1.2', '1.2.3', 'v1.2.3-beta.1', 'v1.2.3-rc.1.other'])(
    'rejects mutable or unsupported tag %s',
    (tag) => expect(() => parseSshRelayReleaseTag(tag)).toThrow(/release tag/i)
  )

  it('derives a content-qualified archive name and exact direct URL', () => {
    const name = sshRelayRuntimeArchiveName('linux-x64-glibc', contentId)

    expect(name).toBe(`orca-ssh-relay-runtime-v1-linux-x64-glibc-${'a'.repeat(64)}.tar.br`)
    expect(sshRelayRuntimeDownloadUrl('v1.2.3-rc.4', name)).toBe(
      `https://github.com/stablyai/orca/releases/download/v1.2.3-rc.4/${name}`
    )
    expect(sshRelayRuntimeDownloadUrl('v1.2.3-rc.4', name)).not.toContain('/latest/')
  })
})

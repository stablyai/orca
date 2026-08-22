import { describe, expect, it } from 'vitest'
import {
  RELAY_OWNER_MANIFEST_MAX_BYTES,
  serializeRelayOwnerManifest
} from '../../shared/relay-owner-manifest'
import {
  createRelayGenerationToken,
  parseRelayGenerationIdentityOutput,
  parseRelayGenerationTerminateOutput,
  parseRelayOwnerProbeOutput,
  relayGenerationIdentityCommand,
  relayGenerationTerminateCommand,
  relayOwnerProbeCommand,
  relayRelaunchReadinessCommand,
  parseRelayRelaunchReadinessOutput
} from './ssh-relay-generation-owner-commands'

const SOCK = '/home/user/.orca-remote/relay-0.1.0/relay-deadbeefdeadbeef.sock'
const GENERATION = 'a'.repeat(64)
const START_TOKEN = 'linux:8271934'
const SOCK_IDENTITY = '2049:999:1785948267'

function probeOutput(body: string): string {
  return `Welcome to Ubuntu\n__ORCA_RELAY_OWNER__\n${body}__ORCA_RELAY_OWNER_END__\n`
}

/** Mirrors the host script: manifest bytes arrive prefixed so they cannot forge probe fields. */
function framedManifest(overrides?: { sock?: string; generation?: string }): string {
  return serializeRelayOwnerManifest({
    generation: overrides?.generation ?? GENERATION,
    pid: 4321,
    socketPath: overrides?.sock ?? SOCK,
    socketDev: 2049,
    socketIno: 999,
    socketCtimeSeconds: 1785948267
  })
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => `m:${line}`)
    .join('\n')
}

function ownedProbeOutput(overrides?: {
  identity?: string
  sock?: string
  generation?: string
}): string {
  return probeOutput(
    `sockid=${overrides?.identity ?? SOCK_IDENTITY}\nmanifest=present\n${framedManifest(overrides)}\n`
  )
}

describe('createRelayGenerationToken', () => {
  it('produces a 64 character lowercase hex token', () => {
    expect(createRelayGenerationToken()).toMatch(/^[0-9a-f]{64}$/)
  })

  it('produces a distinct token per launch', () => {
    const tokens = new Set(Array.from({ length: 64 }, () => createRelayGenerationToken()))
    expect(tokens.size).toBe(64)
  })
})

describe('relayOwnerProbeCommand', () => {
  const command = relayOwnerProbeCommand(SOCK)

  it('bounds the manifest read', () => {
    expect(command).toContain(`head -c ${RELAY_OWNER_MANIFEST_MAX_BYTES}`)
  })

  it('requires a regular file owned by the current user with mode 0600', () => {
    expect(command).toContain('-type f')
    expect(command).toContain('-perm 600')
    expect(command).toContain('-user')
  })

  it('refuses to treat a symlinked socket as the endpoint', () => {
    expect(command).toContain('[ ! -L ')
  })

  it('reads the full socket identity with a GNU-first, BSD-fallback stat', () => {
    expect(command).toContain('stat -c %d:%i:%Z')
    expect(command).toContain('stat -f %d:%i:%c')
  })

  it('prefixes manifest bytes so they cannot forge probe fields or sentinels', () => {
    expect(command).toContain(`head -c ${RELAY_OWNER_MANIFEST_MAX_BYTES}`)
    // awk, not sed: BSD sed leaves an unterminated final line and would glue on the end sentinel.
    expect(command).toContain(`awk '{print "m:" $0}'`)
  })

  it('names a non-socket at the endpoint path instead of reporting it absent', () => {
    expect(command).toContain('orca_sockid=unusable')
  })

  it('quotes every interpolated path', () => {
    expect(command).toContain(`'${SOCK}'`)
    expect(command).toContain(`'${SOCK}.owner'`)
  })

  it('never signals anything', () => {
    expect(command).not.toContain('kill')
  })
})

describe('parseRelayOwnerProbeOutput', () => {
  it('accepts a well-formed manifest whose socket path and inode match', () => {
    const probe = parseRelayOwnerProbeOutput(ownedProbeOutput(), SOCK)
    expect(probe).toMatchObject({ kind: 'owned', socketIdentity: SOCK_IDENTITY })
    expect(probe.kind === 'owned' && probe.manifest.generation).toBe(GENERATION)
  })

  it('reports a legacy relay with no manifest', () => {
    // Why: the observed identity rides along so the caller can tell a legacy relay from a socket
    // that is actively being rebound between two probes.
    expect(
      parseRelayOwnerProbeOutput(probeOutput(`sockid=${SOCK_IDENTITY}\nmanifest=missing\n`), SOCK)
    ).toEqual({ kind: 'no-manifest', socketIdentity: SOCK_IDENTITY })
  })

  it('reports a manifest the host refused to expose as rejected', () => {
    expect(
      parseRelayOwnerProbeOutput(probeOutput(`sockid=${SOCK_IDENTITY}\nmanifest=rejected\n`), SOCK)
    ).toEqual({ kind: 'manifest-rejected' })
  })

  it('reports a manifest naming a different socket path as foreign', () => {
    expect(parseRelayOwnerProbeOutput(ownedProbeOutput({ sock: '/tmp/other.sock' }), SOCK)).toEqual(
      { kind: 'manifest-foreign' }
    )
  })

  it('reports a manifest whose inode lost to a successor socket as superseded', () => {
    // Why: a structurally valid manifest describing a different socket means a successor already
    // took over. That is transient, not a corrupt file, and must stay retryable.
    expect(
      parseRelayOwnerProbeOutput(ownedProbeOutput({ identity: '2049:1000:1785948267' }), SOCK)
    ).toEqual({ kind: 'manifest-superseded', socketIdentity: '2049:1000:1785948267' })
  })

  it('reports a manifest whose socket was recreated at the same inode as superseded', () => {
    expect(
      parseRelayOwnerProbeOutput(ownedProbeOutput({ identity: '2049:999:1785948999' }), SOCK)
    ).toEqual({ kind: 'manifest-superseded', socketIdentity: '2049:999:1785948999' })
  })

  it('rejects a manifest that forges a second sentinel block', () => {
    const forged = probeOutput(
      `sockid=${SOCK_IDENTITY}\nmanifest=present\n${framedManifest()}\n` +
        `m:__ORCA_RELAY_OWNER__\nm:sockid=${SOCK_IDENTITY}\nm:manifest=missing\n`
    )
    expect(parseRelayOwnerProbeOutput(forged, SOCK)).toEqual({ kind: 'manifest-malformed' })
  })

  it('reports a malformed manifest body as malformed', () => {
    expect(
      parseRelayOwnerProbeOutput(
        probeOutput(`sockid=${SOCK_IDENTITY}\nmanifest=present\nm:rubbish\n`),
        SOCK
      )
    ).toEqual({ kind: 'manifest-malformed' })
  })

  it('reports a live socket whose stat produced nothing as unreadable, never absent', () => {
    // Why: an empty sockid used to mean "socket-absent", which authorizes a relaunch. A host whose
    // stat failed on a live socket must not hand out that authorization.
    expect(
      parseRelayOwnerProbeOutput(probeOutput('sockid=unreadable\nmanifest=missing\n'), SOCK)
    ).toEqual({ kind: 'socket-unreadable' })
  })

  it('reports a non-socket at the endpoint path as unusable', () => {
    expect(
      parseRelayOwnerProbeOutput(probeOutput('sockid=unusable\nmanifest=missing\n'), SOCK)
    ).toEqual({ kind: 'socket-unusable' })
  })

  it('reports an absent socket', () => {
    expect(parseRelayOwnerProbeOutput(probeOutput('sockid=\nmanifest=missing\n'), SOCK)).toEqual({
      kind: 'socket-absent'
    })
  })

  it.each([
    ['no sentinel', 'ALIVE\n'],
    ['unterminated sentinel', `__ORCA_RELAY_OWNER__\nsockid=${SOCK_IDENTITY}\n`],
    ['missing manifest marker', probeOutput(`sockid=${SOCK_IDENTITY}\n`)],
    ['empty output', '']
  ])('reports %s as indeterminate', (_label, output) => {
    expect(parseRelayOwnerProbeOutput(output, SOCK)).toEqual({ kind: 'indeterminate' })
  })

  it('ignores login banners emitted before the sentinel', () => {
    const noisy = `sockid=1:1:1\nmanifest=missing\n${ownedProbeOutput()}`
    expect(parseRelayOwnerProbeOutput(noisy, SOCK)).toMatchObject({ kind: 'owned' })
  })
})

describe('relayGenerationIdentityCommand', () => {
  const command = relayGenerationIdentityCommand(4321, GENERATION)

  it('matches the generation token as an exact argv element, not a substring', () => {
    expect(command).toContain('grep -Fxq -e')
  })

  it('checks both the generation token and the relay entry point', () => {
    expect(command).toContain(`'${GENERATION}'`)
    expect(command).toContain("'relay.js'")
  })

  it('reads argv from /proc with a ps fallback', () => {
    expect(command).toContain('/proc/')
    expect(command).toContain('ps -ww')
  })

  it('captures a process start token from /proc with a ps lstart fallback', () => {
    expect(command).toContain('/stat')
    expect(command).toContain('lstart')
  })

  it('never signals the process', () => {
    expect(command).not.toContain('kill -TERM')
    expect(command).not.toContain('kill -9')
  })

  it.each([
    ['a non-integer pid', 1.5],
    ['a zero pid', 0],
    ['a negative pid', -1],
    ['an out-of-range pid', 2 ** 31]
  ])('rejects %s', (_label, pid) => {
    expect(() => relayGenerationIdentityCommand(pid, GENERATION)).toThrow(/pid/i)
  })

  it('rejects a malformed generation token', () => {
    expect(() => relayGenerationIdentityCommand(4321, 'nope; rm -rf /')).toThrow(/generation/i)
  })
})

describe('parseRelayGenerationIdentityOutput', () => {
  it('returns the start token on an exact match', () => {
    expect(
      parseRelayGenerationIdentityOutput(
        `banner\n__ORCA_RELAY_OWNER_ID__\nstate=match\nstart=${START_TOKEN}\n__ORCA_RELAY_OWNER_ID_END__\n`
      )
    ).toEqual({ kind: 'match', startToken: START_TOKEN })
  })

  it.each([
    ['mismatch', 'state=mismatch\nstart=\n', { kind: 'mismatch' }],
    ['gone', 'state=gone\nstart=\n', { kind: 'gone' }],
    ['unknown', 'state=unknown\nstart=\n', { kind: 'indeterminate' }],
    ['match without a start token', 'state=match\nstart=\n', { kind: 'indeterminate' }]
  ])('maps %s', (_label, body, expected) => {
    expect(
      parseRelayGenerationIdentityOutput(
        `__ORCA_RELAY_OWNER_ID__\n${body}__ORCA_RELAY_OWNER_ID_END__\n`
      )
    ).toEqual(expected)
  })

  it.each([
    ['no sentinel', 'state=match\n'],
    ['empty', '']
  ])('treats %s as indeterminate', (_label, output) => {
    expect(parseRelayGenerationIdentityOutput(output)).toEqual({ kind: 'indeterminate' })
  })
})

describe('relayGenerationTerminateCommand', () => {
  const command = relayGenerationTerminateCommand(4321, GENERATION, START_TOKEN)

  it('sends only SIGTERM', () => {
    expect(command).toContain('kill -TERM')
    expect(command).not.toContain('kill -KILL')
    expect(command).not.toContain('kill -9')
  })

  it('revalidates the generation token and start token before signalling', () => {
    const beforeKill = command.slice(0, command.indexOf('kill -TERM'))
    expect(beforeKill).toContain(`'${GENERATION}'`)
    expect(beforeKill).toContain(`'${START_TOKEN}'`)
  })

  it('rejects a start token containing shell metacharacters without quoting it', () => {
    expect(relayGenerationTerminateCommand(4321, GENERATION, "a'; rm -rf /")).toContain(
      `'a'\\''; rm -rf /'`
    )
  })

  it('rejects an empty start token', () => {
    expect(() => relayGenerationTerminateCommand(4321, GENERATION, '')).toThrow(/start/i)
  })

  it('rejects an invalid pid', () => {
    expect(() => relayGenerationTerminateCommand(0, GENERATION, START_TOKEN)).toThrow(/pid/i)
  })
})

describe('parseRelayGenerationTerminateOutput', () => {
  it.each([
    ['signalled', 'signalled'],
    ['mismatch', 'mismatch'],
    ['gone', 'gone'],
    ['unknown', 'indeterminate'],
    ['error', 'indeterminate']
  ])('maps state=%s', (state, expected) => {
    expect(
      parseRelayGenerationTerminateOutput(
        `__ORCA_RELAY_OWNER_ID__\nstate=${state}\n__ORCA_RELAY_OWNER_ID_END__\n`
      )
    ).toBe(expected)
  })

  it('treats unsentinelled output as indeterminate', () => {
    expect(parseRelayGenerationTerminateOutput('signalled')).toBe('indeterminate')
  })
})

describe('relayRelaunchReadinessCommand', () => {
  const command = relayRelaunchReadinessCommand(SOCK)

  it('mutates nothing at all', () => {
    // Why: after the owner exits there is no identity left that can authorize an unlink — a
    // successor at the same path reproduces dev:ino:ctime within one second.
    expect(command).not.toMatch(/\brm\b|\bunlink\b|\bmv\b|>/)
  })

  it('takes neither a socket identity nor a generation', () => {
    expect(relayRelaunchReadinessCommand.length).toBe(1)
    expect(command).not.toContain(SOCK_IDENTITY)
    expect(command).not.toContain(GENERATION)
  })

  it('never names the manifest path', () => {
    expect(command).toContain(`'${SOCK}'`)
    expect(command).not.toContain('.owner')
  })

  it('treats a dangling symlink as an occupied path', () => {
    expect(command).toContain('-L ')
  })

  it('proves the parent directory is searchable before trusting an absent result', () => {
    expect(command).toContain('-d "$orca_dir"')
    expect(command).toContain('-x "$orca_dir"')
  })

  it('rejects a relative path', () => {
    expect(() => relayRelaunchReadinessCommand('relay.sock')).toThrow(/absolute/i)
  })
})

describe('parseRelayRelaunchReadinessOutput', () => {
  it.each([
    ['absent', 'absent'],
    ['present', 'present'],
    ['unknown', 'unknown']
  ])('maps ready=%s', (state, expected) => {
    expect(
      parseRelayRelaunchReadinessOutput(
        `__ORCA_RELAY_RELAUNCH_READY__\nready=${state}\n__ORCA_RELAY_RELAUNCH_READY_END__\n`
      )
    ).toBe(expected)
  })

  it.each([
    ['unsentinelled output', 'absent'],
    [
      'an unknown token',
      '__ORCA_RELAY_RELAUNCH_READY__\nready=maybe\n__ORCA_RELAY_RELAUNCH_READY_END__\n'
    ],
    ['empty output', '']
  ])('never reports absent for %s', (_label, output) => {
    expect(parseRelayRelaunchReadinessOutput(output)).toBe('unknown')
  })
})

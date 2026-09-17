import { describe, expect, it } from 'vitest'
import { createEphemeralAgentSessionClaimSigner } from '../runtime/agent-session-claim-identity'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import { buildVerifiedAgentProcessDiscovery } from './verified-agent-process-discovery'

const signer = createEphemeralAgentSessionClaimSigner('process-discovery-test')
const surface = {
  worktreeId: 'repo::/workspace',
  tabId: 'tab-1',
  leafId: '11111111-1111-4111-8111-111111111111',
  terminalHandle: `term_${'a'.repeat(32)}`
}

function rows(agentStart = 'agent-start'): ProcessTableRow[] {
  return [
    {
      pid: 100,
      ppid: 1,
      pgid: 100,
      tpgid: 200,
      tty: '/dev/pts/1',
      startTime: 'shell-start',
      stat: 'Ss',
      command: '/bin/zsh'
    },
    {
      pid: 150,
      ppid: 100,
      pgid: 200,
      tpgid: 200,
      tty: '/dev/pts/1',
      startTime: 'wrapper-start',
      stat: 'S+',
      command: '/usr/bin/env'
    },
    {
      pid: 200,
      ppid: 150,
      pgid: 200,
      tpgid: 200,
      tty: '/dev/pts/1',
      startTime: agentStart,
      stat: 'S+',
      command: '/usr/local/bin/codex'
    }
  ]
}

function build(table = rows()) {
  const agentRow = table.find((row) => row.pid === 200)
  return buildVerifiedAgentProcessDiscovery({
    ptyId: 'pty-1',
    ptyIncarnationId: '22222222-2222-4222-8222-222222222222',
    rootProcessId: 100,
    authorityGeneration: 'host-1',
    observationEpoch: 1,
    capturedAgeMs: 0,
    surface,
    providerIdentity: {
      agent: 'codex',
      source: 'provider-session',
      session: { key: 'session_id', id: 'codex-session-1' },
      observation: {
        authorityId: 'hooks-1',
        incarnation: 1,
        revision: 1,
        process: { pid: 200, startTime: agentRow?.startTime ?? 'missing' }
      }
    },
    createClaim: ({ agent, launchIdentity, canonicalWorktreeId }) =>
      signer.createFreshClaim({
        namespace: {
          machine: 'native:linux',
          principal: 'uid:1',
          container: 'native',
          providerRoot: `profile-default:${agent}`
        },
        agent,
        launchIdentity,
        canonicalWorktreeId
      }),
    rows: table,
    platform: 'linux'
  })
}

describe('verified agent process discovery producer', () => {
  it('binds a recognized process to its exact host ancestry and process incarnation', () => {
    expect(build()).toMatchObject({
      claim: { agent: 'codex' },
      surface,
      evidence: {
        verdict: 'live',
        processName: 'codex',
        ptyId: 'pty-1',
        fence: { process: { pid: 200, startTime: 'agent-start' } }
      },
      providerIdentity: {
        agent: 'codex',
        source: 'provider-session',
        session: { key: 'session_id', id: 'codex-session-1' }
      },
      ancestry: {
        parent: { pid: 150, startTime: 'wrapper-start' },
        chain: [
          { pid: 100, startTime: 'shell-start' },
          { pid: 150, startTime: 'wrapper-start' }
        ],
        relation: 'descendant'
      },
      process: { pid: 200, startTime: 'agent-start', parentPid: 150 }
    })
  })

  it('mints a different subject for a replaced process and rejects incomplete ancestry', () => {
    const first = build()
    const replacement = build(rows('agent-replacement-start'))
    expect(replacement?.claim.identityDigest).not.toBe(first?.claim.identityDigest)
    expect(build(rows().filter((row) => row.pid !== 150))).toBeNull()
  })

  it('does not admit an ordinary foreground process as an agent subject', () => {
    const ordinary = rows()
    ordinary[2] = { ...ordinary[2], command: 'node /srv/server.js' }
    expect(build(ordinary)).toBeNull()
  })

  it('requires the hook observation to name the exact foreground process incarnation', () => {
    const table = rows()
    const candidate = buildVerifiedAgentProcessDiscovery({
      ptyId: 'pty-1',
      ptyIncarnationId: '22222222-2222-4222-8222-222222222222',
      rootProcessId: 100,
      authorityGeneration: 'host-1',
      observationEpoch: 1,
      capturedAgeMs: 0,
      surface,
      providerIdentity: {
        agent: 'codex',
        source: 'provider-session',
        session: { key: 'session_id', id: 'delayed-old-session' },
        observation: {
          authorityId: 'hooks-1',
          incarnation: 1,
          revision: 9,
          process: { pid: 199, startTime: 'old-agent-start' }
        }
      },
      createClaim: ({ agent, launchIdentity, canonicalWorktreeId }) =>
        signer.createFreshClaim({
          namespace: {
            machine: 'native:linux',
            principal: 'uid:1',
            container: 'native',
            providerRoot: `profile-default:${agent}`
          },
          agent,
          launchIdentity,
          canonicalWorktreeId
        }),
      rows: table,
      platform: 'linux'
    })

    expect(candidate).toBeNull()
  })

  it('does not promote a nested agent process as the pane root', () => {
    const nestedRows = rows()
    nestedRows[1] = { ...nestedRows[1], command: '/usr/local/bin/codex' }

    expect(build(nestedRows)).toBeNull()
  })
})

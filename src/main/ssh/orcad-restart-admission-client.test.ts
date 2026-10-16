import { describe, expect, it, vi } from 'vitest'
import { ORCAD_RESTART_ADMISSION_RUNTIME_CAPABILITY } from '../../shared/orcad-runtime-capabilities'
import type { PairedRuntimeConnection } from '../../shared/paired-runtime-connection'

const send = vi.hoisted(() => vi.fn())
vi.mock('../../shared/remote-runtime-client', () => ({
  sendRemoteRuntimeRequestWithStatusPreflight: send
}))

import { orcadRestartAdmissionPort } from './orcad-restart-admission-client'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the request is stubbed.
const connection = {} as PairedRuntimeConnection
const port = orcadRestartAdmissionPort((run) => run(connection), 1_000)
const CENSUS = {
  liveSessions: 0,
  startedSinceActivation: 0,
  daemonProtocolVersion: 3,
  chatWork: 0
}

/** Answers through the status preflight, as the socket client does before the request. */
function server(capabilities: string[], answer: () => unknown): void {
  send.mockImplementation(async (_connection, _method, _params, _timeout, validate) => {
    validate({ ok: true, result: { capabilities } })
    return { ok: true, result: answer() }
  })
}

describe('orcadRestartAdmissionPort', () => {
  it('reserves with the fresh census on a server that advertises the capability', async () => {
    server([ORCAD_RESTART_ADMISSION_RUNTIME_CAPABILITY], () => ({
      status: 'reserved',
      token: 't',
      census: CENSUS
    }))
    await expect(port.reserve(true)).resolves.toEqual({
      status: 'reserved',
      token: 't',
      census: CENSUS
    })
    expect(send.mock.calls[0]?.[2]).toEqual({ action: 'reserve', activatedAt: 1_000, force: true })
  })

  // Mixed versions: an older server is never asked, so it can never be read as idle.
  it('never reserves on a server without the capability', async () => {
    const answer = vi.fn()
    server([], answer)
    await expect(port.reserve(false)).resolves.toMatchObject({ status: 'defer' })
    expect(answer).not.toHaveBeenCalled()
  })

  // A lost answer may follow a commit the server already began, so it is never "refused".
  it('reads a commit whose answer was lost as unknown, and a release failure as done', async () => {
    send.mockRejectedValue(new Error('socket closed'))
    await expect(port.commit('t')).resolves.toBe('unknown')
    await expect(port.release('t')).resolves.toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import {
  DAEMON_CLIENT_ID_MAX_BYTES,
  DAEMON_PTY_COMMAND_MAX_BYTES,
  DAEMON_PTY_CWD_MAX_BYTES,
  DAEMON_PTY_ENV_DELETE_MAX_ENTRIES,
  DAEMON_PTY_ENV_MAX_BYTES,
  DAEMON_PTY_ENV_MAX_ENTRIES,
  DAEMON_PTY_ENV_VALUE_MAX_BYTES,
  DAEMON_PTY_HISTORY_SEED_MAX_BYTES,
  DAEMON_REQUEST_ID_MAX_BYTES,
  DAEMON_SESSION_ID_MAX_BYTES,
  daemonHelloAdmissionError,
  daemonRequestAdmissionError
} from './daemon-admission-limits'
import { MAX_TERMINAL_COLS, MAX_TERMINAL_ROWS } from '../../shared/terminal-size-limits'

function createRequest(payload: Record<string, unknown>): Record<string, unknown> {
  return { id: 'req-1', type: 'createOrAttach', payload }
}

describe('daemon admission limits', () => {
  it('preserves ordinary cross-platform create fields without rewriting them', () => {
    const request = createRequest({
      sessionId: 'repo::C:\\projects\\orca@@12345678',
      cols: 120,
      rows: 40,
      cwd: '\\\\wsl.localhost\\Ubuntu\\home\\orca',
      command: 'printf "ready"',
      env: { PATH: 'C:\\Windows\\System32', ORCA_TERMINAL_HANDLE: 'term_123' },
      envToDelete: ['CODEX_HOME'],
      terminalWindowsWslDistro: null,
      historySeed: '\u001b[32mrestored\u001b[0m'
    })

    expect(daemonRequestAdmissionError(request)).toBeNull()
    expect(request).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          cwd: '\\\\wsl.localhost\\Ubuntu\\home\\orca',
          terminalWindowsWslDistro: null
        })
      })
    )
  })

  it('measures hello and request identifiers by UTF-8 bytes', () => {
    const exactClientId = 'é'.repeat(DAEMON_CLIENT_ID_MAX_BYTES / 2)
    expect(
      daemonHelloAdmissionError({ type: 'hello', role: 'control', clientId: exactClientId })
    ).toBeNull()
    expect(
      daemonHelloAdmissionError({
        type: 'hello',
        role: 'control',
        clientId: `${exactClientId}é`
      })
    ).toContain(`${DAEMON_CLIENT_ID_MAX_BYTES} bytes`)

    const exactRequestId = 'é'.repeat(DAEMON_REQUEST_ID_MAX_BYTES / 2)
    expect(daemonRequestAdmissionError({ id: exactRequestId, type: 'ping' })).toBeNull()
    expect(daemonRequestAdmissionError({ id: `${exactRequestId}é`, type: 'ping' })).toContain(
      `${DAEMON_REQUEST_ID_MAX_BYTES} bytes`
    )
  })

  it('rejects unbounded retained identifiers and PTY strings', () => {
    expect(
      daemonRequestAdmissionError({
        id: 'req',
        type: 'getCwd',
        payload: { sessionId: 's'.repeat(DAEMON_SESSION_ID_MAX_BYTES + 1) }
      })
    ).toContain(`${DAEMON_SESSION_ID_MAX_BYTES} bytes`)
    expect(
      daemonRequestAdmissionError(
        createRequest({
          sessionId: 's',
          cwd: 'c'.repeat(DAEMON_PTY_CWD_MAX_BYTES + 1)
        })
      )
    ).toContain(`${DAEMON_PTY_CWD_MAX_BYTES} bytes`)
    expect(
      daemonRequestAdmissionError(
        createRequest({
          sessionId: 's',
          command: 'c'.repeat(DAEMON_PTY_COMMAND_MAX_BYTES + 1)
        })
      )
    ).toContain(`${DAEMON_PTY_COMMAND_MAX_BYTES} bytes`)
    expect(
      daemonRequestAdmissionError(
        createRequest({
          sessionId: 's',
          historySeed: 'h'.repeat(DAEMON_PTY_HISTORY_SEED_MAX_BYTES + 1)
        })
      )
    ).toContain(`${DAEMON_PTY_HISTORY_SEED_MAX_BYTES} bytes`)
  })

  it('caps environment entry counts, individual values, and aggregate bytes', () => {
    const tooManyEntries = Object.fromEntries(
      Array.from({ length: DAEMON_PTY_ENV_MAX_ENTRIES + 1 }, (_, index) => [`K${index}`, 'v'])
    )
    expect(
      daemonRequestAdmissionError(createRequest({ sessionId: 's', env: tooManyEntries }))
    ).toContain(`${DAEMON_PTY_ENV_MAX_ENTRIES} entries`)

    expect(
      daemonRequestAdmissionError(
        createRequest({
          sessionId: 's',
          env: { VALUE: 'v'.repeat(DAEMON_PTY_ENV_VALUE_MAX_BYTES + 1) }
        })
      )
    ).toContain(`${DAEMON_PTY_ENV_VALUE_MAX_BYTES} bytes`)

    const aggregate = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [
        `K${index}`,
        'v'.repeat(Math.floor(DAEMON_PTY_ENV_MAX_BYTES / 5))
      ])
    )
    expect(
      daemonRequestAdmissionError(createRequest({ sessionId: 's', env: aggregate }))
    ).toContain(`${DAEMON_PTY_ENV_MAX_BYTES} bytes`)
  })

  it('caps environment deletion lists and rejects malformed retained fields', () => {
    expect(
      daemonRequestAdmissionError(
        createRequest({
          sessionId: 's',
          envToDelete: Array.from(
            { length: DAEMON_PTY_ENV_DELETE_MAX_ENTRIES + 1 },
            (_, index) => `K${index}`
          )
        })
      )
    ).toContain(`${DAEMON_PTY_ENV_DELETE_MAX_ENTRIES} entries`)
    expect(
      daemonRequestAdmissionError(createRequest({ sessionId: 's', env: ['not-a-record'] }))
    ).toBe('createOrAttach payload.env must be a string record')
    expect(daemonRequestAdmissionError({ id: 'req', type: 'getCwd', payload: {} })).toBe(
      'getCwd payload.sessionId must be a string'
    )
  })

  it('rejects PTY dimensions that could force pathological native allocations', () => {
    expect(
      daemonRequestAdmissionError(
        createRequest({ sessionId: 's', cols: MAX_TERMINAL_COLS + 1, rows: 24 })
      )
    ).toContain(`1 through ${MAX_TERMINAL_COLS}`)
    expect(
      daemonRequestAdmissionError({
        id: 'req',
        type: 'resize',
        payload: { sessionId: 's', cols: 80, rows: MAX_TERMINAL_ROWS + 1 }
      })
    ).toContain(`1 through ${MAX_TERMINAL_ROWS}`)
  })
})

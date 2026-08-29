import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUTOMATION_OWNER_CONFLICT_CODES } from '../shared/automation-owner-conflict'
import { formatCliError, reportCliError } from './format'
import { RuntimeRpcFailureError } from './runtime-client'

function conflict(code: string, message: string): RuntimeRpcFailureError {
  return new RuntimeRpcFailureError({
    id: 'request-1',
    ok: false,
    error: { code, message: `${message}: ${code}` },
    _meta: { runtimeId: 'runtime-1' }
  })
}

afterEach(() => vi.restoreAllMocks())

describe('automation owner conflicts read as CLI outcomes', () => {
  it('drops the machine token from the human message and names the recovery', () => {
    const output = formatCliError(
      conflict(AUTOMATION_OWNER_CONFLICT_CODES.ownerChanged, "This automation's host changed.")
    )

    expect(output).toContain("This automation's host changed.")
    expect(output).not.toContain('automation_owner_changed')
    expect(output).toContain('Next step: Run the command again')
  })

  // A removed SSH host fails identically forever, so proposing a retry would send
  // the user in a loop instead of to the two things that actually resolve it.
  it('never proposes a retry for a removed target', () => {
    const output = formatCliError(
      conflict(AUTOMATION_OWNER_CONFLICT_CODES.targetRemoved, 'Host removed.')
    )

    expect(output).not.toMatch(/run the command again|try again/i)
    expect(output).toContain('retrying will not change that')
    expect(output).toContain('Re-add that SSH host')
    expect(output).toContain('orca automations remove')
  })

  it('keeps the code machine-readable in --json while carrying the same steps', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    reportCliError(
      conflict(AUTOMATION_OWNER_CONFLICT_CODES.fencingRequired, 'Owner required.'),
      true
    )

    const payload = JSON.parse(log.mock.calls[0]![0] as string)
    expect(payload.error.code).toBe('automation_owner_fencing_required')
    expect(payload.error.message).toBe('Owner required.')
    expect(payload.error.data.nextSteps[1]).toContain('Update Orca on the host')
  })

  it('leaves unrelated failures untouched', () => {
    const output = formatCliError(conflict('runtime_error', 'Something else'))

    expect(output).toBe('Something else: runtime_error')
  })

  // The trailing token is the convention precisely because a hop can flatten the
  // error class. Classifying on `.code` alone reads only the hop that preserved it,
  // and the user loses the recovery on every other one.
  it('recovers the conflict from the message when a hop flattened the code', () => {
    const flattened = new RuntimeRpcFailureError({
      id: 'request-1',
      ok: false,
      error: {
        code: 'runtime_error',
        message: `This automation's host changed.: ${AUTOMATION_OWNER_CONFLICT_CODES.ownerChanged}`
      },
      _meta: { runtimeId: 'runtime-1' }
    })

    const output = formatCliError(flattened)

    expect(output).not.toContain('automation_owner_changed')
    expect(output).toContain('Next step: Run the command again')
  })

  it('restores the flattened code for --json consumers', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    reportCliError(
      new RuntimeRpcFailureError({
        id: 'request-1',
        ok: false,
        error: {
          code: 'runtime_error',
          message: `Host removed.: ${AUTOMATION_OWNER_CONFLICT_CODES.targetRemoved}`
        },
        _meta: { runtimeId: 'runtime-1' }
      }),
      true
    )

    const payload = JSON.parse(log.mock.calls[0]![0] as string)
    expect(payload.error.code).toBe('automation_target_removed')
    expect(payload.error.message).toBe('Host removed.')
    expect(payload.error.data.nextSteps[0]).toContain('no longer registered')
  })

  // A local throw never reaches the envelope, so the token is all the CLI has.
  it('classifies a locally thrown conflict the same way', () => {
    const output = formatCliError(
      new Error(
        `Destination host is not registered.: ${AUTOMATION_OWNER_CONFLICT_CODES.invalidDestination}`
      )
    )

    expect(output).not.toContain('automation_destination_invalid')
    expect(output).toContain('Next step: Run `orca automations show --id <id>`')
  })
})

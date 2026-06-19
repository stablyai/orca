import { describe, expect, it } from 'vitest'
import { mapRuntimeError } from './errors'

class LineageError extends Error {
  code = 'LINEAGE_PARENT_NOT_FOUND'
  data = {
    nextSteps: ['Run `orca worktree list`.', 'Retry with --no-parent.']
  }
}

describe('mapRuntimeError', () => {
  it.each([
    ['window_not_focused', 'keyboard input requires focus', 'restore-window'],
    ['permission_denied', 'missing DBUS_SESSION_BUS_ADDRESS', 'permissions'],
    ['element_not_found', 'fresh element index required', 'get-app-state'],
    ['unsupported_capability', 'hotkey combinations require xdotool', 'capabilities'],
    [
      'action_not_supported',
      'Raise is not a valid secondary action',
      'advertised secondary actions'
    ],
    ['value_not_settable', 'element value is not settable', 'settable text element'],
    ['element_not_clickable', 'element has no actionable frame', 'actionable frame'],
    ['invalid_argument', 'click_count must be a positive integer', 'Do not retry'],
    ['action_timeout', 'computer sidecar click timed out', 'do not repeat'],
    ['screenshot_failed', 'screenshot capture returned no image', '--no-screenshot'],
    ['accessibility_error', 'desktop script provider is not available', 'capabilities']
  ])('adds recovery steps for computer-use %s errors', (code, message, recoveryFragment) => {
    const error = new Error(message)
    Object.assign(error, { code })

    const response = mapRuntimeError('req_1', { runtimeId: 'runtime-1' }, error)

    expect(response.error).toMatchObject({
      code,
      message,
      data: {
        nextSteps: expect.arrayContaining([expect.stringContaining(recoveryFragment)])
      }
    })
  })

  it('adds computer-use startup recovery steps for missing desktop apps', () => {
    const error = new Error('app not found: Gmail')
    Object.assign(error, { code: 'app_not_found' })

    const response = mapRuntimeError('req_1', { runtimeId: 'runtime-1' }, error)

    expect(response.error).toMatchObject({
      code: 'app_not_found',
      message: 'app not found: Gmail',
      data: {
        nextSteps: [
          expect.stringContaining('list-apps'),
          expect.stringContaining('desktop browser app/window'),
          expect.stringContaining('--app <web app>'),
          expect.stringContaining('list-windows --app <browser>')
        ]
      }
    })
  })

  it('adds computer-use recovery steps for missing desktop windows', () => {
    const error = new Error('No top-level window found')
    Object.assign(error, { code: 'window_not_found' })

    const response = mapRuntimeError('req_1', { runtimeId: 'runtime-1' }, error)

    expect(response.error).toMatchObject({
      code: 'window_not_found',
      data: {
        nextSteps: [
          expect.stringContaining('list-windows'),
          expect.stringContaining('--restore-window'),
          expect.stringContaining('does not launch closed desktop apps')
        ]
      }
    })
  })

  it('preserves structured computer-use focus error codes for CLI recovery hints', () => {
    const error = new Error(
      'keyboard input requires the target window to be focused; retry with --restore-window'
    )
    Object.assign(error, { code: 'window_not_focused' })

    const response = mapRuntimeError('req_1', { runtimeId: 'runtime-1' }, error)

    expect(response).toEqual({
      id: 'req_1',
      ok: false,
      error: {
        code: 'window_not_focused',
        message:
          'keyboard input requires the target window to be focused; retry with --restore-window',
        data: {
          nextSteps: [
            'Retry once with `--restore-window`.',
            'If `--restore-window` was already used, stop retrying restore; bring the app forward manually, check permissions, or prefer `set-value` for editable fields.'
          ]
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
  })

  it('preserves structured lineage error codes and data for CLI recovery hints', () => {
    const response = mapRuntimeError(
      'req_1',
      { runtimeId: 'runtime-1' },
      new LineageError('Parent workspace was not found.')
    )

    expect(response).toEqual({
      id: 'req_1',
      ok: false,
      error: {
        code: 'LINEAGE_PARENT_NOT_FOUND',
        message: 'Parent workspace was not found.',
        data: {
          nextSteps: ['Run `orca worktree list`.', 'Retry with --no-parent.']
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
  })
})

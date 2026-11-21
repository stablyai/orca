import { describe, expect, it } from 'vitest'
import { leftoverPermissionStatusPath } from './macos-permission-status-leftover-reap'

const HELPER =
  '/Applications/Orca.app/Contents/Resources/Orca Computer Use.app/Contents/MacOS/orca-computer-use-macos'
const STATUS = '/var/folders/ab/T/orca-computer-use-permissions-Ab12Cd/status.json'

describe('leftoverPermissionStatusPath', () => {
  it('selects a LaunchServices-launched probe, including a temp dir with spaces', () => {
    expect(leftoverPermissionStatusPath(1, `${HELPER} --permission-status-file ${STATUS}`)).toBe(
      STATUS
    )
    const spaced = '/Volumes/Dev SSD/tmp/orca-computer-use-permissions-Zz99Yy/status.json'
    expect(leftoverPermissionStatusPath(1, `${HELPER} --permission-status-file ${spaced}`)).toBe(
      spaced
    )
  })

  it('never selects the agent, setup helpers, wrappers or other status files', () => {
    for (const [parentPid, command] of [
      [4242, `${HELPER} --permission-status-file ${STATUS}`],
      [4242, `/usr/bin/lldb -- ${HELPER} --permission-status-file ${STATUS}`],
      [1, `lldb -- ${HELPER} --permission-status-file ${STATUS}`],
      [1, `${HELPER} --agent /tmp/orca-computer-use-sock/provider.sock --token-file /tmp/t`],
      [1, `${HELPER} --permission accessibility`],
      [1, `${HELPER} --permissions`],
      [1, `${HELPER} --permission-status`],
      [1, `${HELPER} --permission-status-file /tmp/other/status.json`],
      [1, `${HELPER} --permission-status-file ${STATUS}.peer`]
    ] as const) {
      expect(leftoverPermissionStatusPath(parentPid, command)).toBeNull()
    }
  })
})

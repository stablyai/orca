import { defineMethod } from '../../core'
import { callerTabPerson } from '../../../../bots/team-share/teammate-rules'
import { OpenFileTab } from '../../../../../shared/rpc-contract/session-tabs/session-tab-open-file-params'

/** A teammate's file tab in their agent's Home (teammate-rules.ts, rule 4): their own workspace holds
 *  it; nothing opens in the host's window. Everyone else opens files there with `files.open`. */
export const SESSION_TAB_OPEN_FILE_METHOD = defineMethod({
  name: 'session.tabs.openFile',
  permission: 'workspace',
  share: 'not-shared',
  params: OpenFileTab,
  handler: async (params, { runtime, pairedDeviceId, callerScope }) =>
    runtime.openTabListFile(
      params.worktree,
      {
        relativePath: params.relativePath,
        mode: params.mode ?? 'edit',
        ...(params.oldPath ? { oldPath: params.oldPath } : {})
      },
      {
        person: callerTabPerson(callerScope),
        ...(pairedDeviceId ? { clientNavigationId: pairedDeviceId } : {}),
        ...(params.activate === false ? { activate: false } : {})
      }
    )
})

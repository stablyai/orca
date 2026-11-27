import type { RuntimeJiraCommands } from '../integrations/jira/runtime-jira-commands'
import type { RuntimeEmulatorCommands } from '../emulator/runtime-emulator-commands'
import type { RuntimeItsaplanCommands } from '../integrations/itsaplan/runtime-itsaplan-commands'

type PublicMethods<T> = Pick<T, keyof T>

export const JIRA_ASYNC_COMMAND_NAMES = [
  'jiraGenerateIssueSummary',
  'jiraConnect',
  'jiraDisconnect',
  'jiraSelectSite',
  'jiraStatus',
  'jiraReadStatus',
  'jiraTestConnection',
  'jiraSearchIssues',
  'jiraListIssues',
  'jiraCreateIssue',
  'jiraGetIssue',
  'jiraLookupIssueSummary',
  'jiraUpdateIssue',
  'jiraAddIssueComment',
  'jiraIssueComments',
  'jiraListProjects',
  'jiraListFavouriteFilters',
  'jiraListIssueTypes',
  'jiraListCreateFields',
  'jiraListPriorities',
  'jiraListAssignableUsers',
  'jiraSearchUsers',
  'jiraListTransitions',
  'jiraGetProjectStatusOrder'
] as const satisfies readonly Exclude<keyof RuntimeJiraCommands, 'jiraCancelGenerateIssueSummary'>[]

export const EMULATOR_COMMAND_NAMES = [
  'emulatorTap',
  'emulatorGesture',
  'emulatorType',
  'emulatorButton',
  'emulatorRotate',
  'emulatorSyncKeyboardLayout',
  'emulatorCheckInput',
  'emulatorExec',
  'emulatorAttach',
  'emulatorList',
  'emulatorUnregisterActive',
  'emulatorListSimulators',
  'emulatorAvailability',
  'emulatorListDevices',
  'emulatorInstall',
  'emulatorLaunch',
  'emulatorPermissions',
  'emulatorAx',
  'emulatorLogcat',
  'emulatorKill',
  'emulatorShutdown',
  'emulatorExecRaw'
] as const satisfies readonly (keyof RuntimeEmulatorCommands)[]

export const ITSAPLAN_COMMAND_NAMES = [
  'itsaplanDetectApiUrl',
  'itsaplanConnect',
  'itsaplanDisconnect',
  'itsaplanStatus',
  'itsaplanTestConnection',
  'itsaplanListProjects',
  'itsaplanGetProjectMetadata',
  'itsaplanListIssues',
  'itsaplanGetIssue',
  'itsaplanCreateIssue',
  'itsaplanUpdateIssue',
  'itsaplanAddComment'
] as const satisfies readonly (keyof RuntimeItsaplanCommands)[]

let itsaplanCommands: Promise<RuntimeItsaplanCommands> | null = null

// Stateless commands, so one shared instance serves every controller.
export function loadItsaplanCommands(): Promise<RuntimeItsaplanCommands> {
  itsaplanCommands ??= import('../integrations/itsaplan/runtime-itsaplan-commands')
    .then(({ RuntimeItsaplanCommands }) => new RuntimeItsaplanCommands())
    .catch((error: unknown) => {
      itsaplanCommands = null
      throw error
    })
  return itsaplanCommands
}

export function bindLazyAsyncMethods<T extends object>(
  load: () => Promise<T>,
  names: readonly (keyof T)[]
): Partial<PublicMethods<T>> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fromEntries loses the key type of the names it was built from.
  return Object.fromEntries(
    names.map((name) => [
      name,
      async (...args: unknown[]) => {
        const instance = await load()
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every name in names is checked against T, whose members are all methods.
        return (instance[name] as (...callArgs: unknown[]) => unknown)(...args)
      }
    ])
  ) as Partial<PublicMethods<T>>
}

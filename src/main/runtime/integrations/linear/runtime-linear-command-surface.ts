import type { RuntimeLinearCommands } from './runtime-linear-connection-commands'

type PublicMethods<T> = Pick<T, keyof T>

export type RuntimeLinearCommandSurface = PublicMethods<RuntimeLinearCommands>

type LinearFacadeInstance = {
  loadLinearCommands(): Promise<RuntimeLinearCommands>
}

type LinearMethodBag = Record<string, (...values: unknown[]) => unknown>

const LINEAR_COMMAND_NAMES = [
  'linearConnect',
  'linearDisconnect',
  'linearSelectWorkspace',
  'linearStatus',
  'linearTestConnection',
  'linearSearchIssues',
  'linearSearchForAgents',
  'linearIssueContext',
  'linearTeamListForAgents',
  'linearTeamMembersForAgents',
  'linearTeamStatesForAgents',
  'linearTeamLabelsForAgents',
  'linearProjectListForAgents',
  'linearIssueListForAgents',
  'linearMcpIssueList',
  'linearListIssues',
  'linearCreateIssue',
  'linearGetIssue',
  'linearUpdateIssue',
  'linearAddIssueComment',
  'linearIssueAddComment',
  'linearIssueAttachLink',
  'linearCommentEdit',
  'linearCommentDelete',
  'linearIssueCreate',
  'linearIssueSetState',
  'linearIssueRelationWrite',
  'linearSaveIssue',
  'linearIssueUpdateTask',
  'linearResolveCurrentIssue',
  'linearIssueComments',
  'linearListTeams',
  'linearListProjects',
  'linearCreateProject',
  'linearGetProject',
  'linearListProjectIssues',
  'linearListCustomViews',
  'linearGetCustomView',
  'linearListCustomViewIssues',
  'linearListCustomViewProjects',
  'linearTeamStates',
  'linearTeamLabels',
  'linearTeamMembers'
] as const satisfies readonly (keyof RuntimeLinearCommands)[]

const LINEAR_COMMAND_NAME_SET: ReadonlySet<string> = new Set(LINEAR_COMMAND_NAMES)
const delegators = new WeakSet<object>()
const receiverByCommands = new WeakMap<LinearMethodBag, LinearMethodBag>()

// Preserve facade overrides/spies on reentrant this calls through the chain.
function overrideAwareReceiver(
  facade: LinearFacadeInstance,
  commands: LinearMethodBag,
  surfaceNames: ReadonlySet<string>
): LinearMethodBag {
  const cached = receiverByCommands.get(commands)
  if (cached) {
    return cached
  }
  const receiver = new Proxy(commands, {
    get(target, property, proxyReceiver) {
      if (typeof property === 'string' && surfaceNames.has(property)) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: facade is the runtime instance that may carry test overrides for surface methods.
        const override = (facade as Record<string, unknown>)[property]
        if (typeof override === 'function' && !delegators.has(override)) {
          return override.bind(facade)
        }
      }
      // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy `get` trap: raw string|symbol pass-through; the receiver stays the target on purpose.
      return Reflect.get(target, property, proxyReceiver)
    }
  })
  receiverByCommands.set(commands, receiver)
  return receiver
}

export function installRuntimeLinearCommandSurface(target: LinearFacadeInstance): void {
  for (const name of LINEAR_COMMAND_NAMES) {
    const method = {
      async [name](this: LinearFacadeInstance, ...args: unknown[]): Promise<unknown> {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: RuntimeLinearCommands implements every name in LINEAR_COMMAND_NAMES.
        const commands = (await this.loadLinearCommands()) as unknown as LinearMethodBag
        return commands[name].call(
          overrideAwareReceiver(this, commands, LINEAR_COMMAND_NAME_SET),
          ...args
        )
      }
    }[name]
    delegators.add(method)
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: false,
      writable: true,
      value: method
    })
  }
}

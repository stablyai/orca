import { vi } from 'vitest'
import * as profilePaths from '../orca-profiles/profile-storage-paths'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { STRUCTURED_AGENT_RUNTIME_REGISTRATIONS } from './structured-agent-runtime-registrations'
import { partialRuntimeStore, storeFolderWorkspace } from './runtime-store-partial-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import type { OrchestrationDb } from './orchestration/db'
import { stopStructuredAgentSessionRuntime } from './structured-agent-session-runtime'
import { scriptedCodexTransport } from './scripted-codex-transport.test-fixture'
import { attachParams, type fakeCodex } from './structured-chat-coordinator-fake-codex-fixture'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import { join } from 'node:path'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'

export function mailChatAttachParams(
  id: string,
  root: string,
  defaultInstallation: boolean
): Parameters<StructuredAgentSessionHost['attach']>[1] {
  const params = attachParams(id)
  return defaultInstallation
    ? {
        ...params,
        location: {
          ...params.location,
          workspaceId: folderWorkspaceKey('workspace-1'),
          workspaceKind: 'folder'
        },
        accountHome: { variable: 'CODEX_HOME', path: join(root, 'scripted-codex-home') }
      }
    : params
}

/** Keep workspace-process-listing, assembly and callbacks real; script only external child/catalog I/O. */
export async function createDefaultMailHost(
  root: string,
  db: OrchestrationDb,
  codex: ReturnType<typeof fakeCodex>
) {
  await stopStructuredAgentSessionRuntime()
  vi.spyOn(profilePaths, 'getProfileUserDataPath').mockReturnValue(root)
  const folder = storeFolderWorkspace({
    id: 'workspace-1',
    projectGroupId: 'group',
    folderPath: root
  })
  const runtime = new OrcaRuntimeService(
    partialRuntimeStore({
      getSettings: () => ({
        experimentalNativeChat: true,
        nativeChatInlineVisuals: false,
        nativeChatAutoName: false
      }),
      getFolderWorkspaces: () => [folder],
      getFolderWorkspace: (id) => (id === folder.id ? folder : undefined)
    })
  )
  runtime.setOrchestrationDb(db)
  for (const registration of STRUCTURED_AGENT_RUNTIME_REGISTRATIONS) {
    vi.spyOn(registration, 'modelCatalog').mockReturnValue({
      kind: 'unavailable',
      reason: 'scripted external catalog'
    })
    if (registration.definition.agent === 'codex') {
      const create = registration.createAdapter
      vi.spyOn(registration, 'createAdapter').mockImplementation((context) =>
        create({
          ...context,
          deps: { ...context.deps, ...scriptedCodexTransport(codex.openConnection) }
        })
      )
    }
  }
  await runtime.ensureStructuredAgentSessionHost()
  const installed = getStructuredAgentSessionHost()
  if (!installed) {
    throw new Error('default assembly did not install its host')
  }
  return { runtime, host: installed }
}

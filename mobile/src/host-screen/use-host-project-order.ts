import { useCallback, useRef } from 'react'
import { randomUUID } from 'expo-crypto'
import {
  PERSONAL_PROJECT_ORDER_CAPABILITY,
  newerPersonalProjectOrder
} from '../../../src/shared/personal-project-order'
import { resolveProjectPreferenceKey } from '../../../src/shared/project-preference-identity'
import { getRepoExecutionHostId } from '../../../src/shared/execution-host'
import type { ProjectOrderBy } from '../../../src/shared/ui-chrome-types'
import type { SectionRepo } from '../worktree/workspace-list-types'
import type { ServedProjectSections } from '../worktree/project-sections-operations'
import type { MobileViewState } from '../worktree/workspace-view-settings'
import type { HostScreenState } from './use-host-screen-state'
import type { RpcClient } from '../transport/rpc-client'
import { projectPinWrite, hostViewSettingsWrite } from './host-screen-operations'

export function useHostProjectOrder(args: {
  client: RpcClient | null
  state: HostScreenState
  hostCapabilities?: readonly string[]
  projectCatalog?: ServedProjectSections | null
  applyViewState: (next: MobileViewState) => void
  refused: () => void
  syncViewSettingsFromDesktop: () => Promise<void>
}) {
  const { client, state, applyViewState, refused, syncViewSettingsFromDesktop } = args
  const { clientRef, viewRef } = state
  const supportsPersonalProjectOrder =
    args.hostCapabilities?.includes(PERSONAL_PROJECT_ORDER_CAPABILITY) === true
  const pinWriter = useRef({ writer: randomUUID(), seq: 0 })
  const setProjectOrderBy = useCallback(
    async (value: ProjectOrderBy) => {
      if (
        !client ||
        ((value === 'name' || value === 'frequent') && !supportsPersonalProjectOrder)
      ) {
        return
      }
      try {
        const reply = await hostViewSettingsWrite.request(client, { projectOrderBy: value })
        if (clientRef.current !== client) {
          return
        }
        if (!hostViewSettingsWrite.interpret(reply).accepted) {
          refused()
          return
        }
        await syncViewSettingsFromDesktop()
      } catch {
        refused()
      }
    },
    [client, supportsPersonalProjectOrder, refused, syncViewSettingsFromDesktop]
  )

  const toggleProjectPin = useCallback(
    async (repo: SectionRepo) => {
      if (!client || !supportsPersonalProjectOrder) {
        return
      }
      const catalog = args.projectCatalog ?? state.servedProjectSections
      const projectKey = catalog
        ? resolveProjectPreferenceKey(repo.id, catalog.setups, getRepoExecutionHostId(repo))
        : null
      if (!projectKey) {
        return
      }
      const pinned = viewRef.current.personalProjectOrder?.projects[projectKey]?.pinned === true
      try {
        const reply = await projectPinWrite.request(client, {
          projectKey,
          pinned: !pinned,
          opId: { writer: pinWriter.current.writer, seq: ++pinWriter.current.seq }
        })
        if (clientRef.current !== client) {
          return
        }
        const result = projectPinWrite.interpret(reply)
        if (!result.accepted) {
          refused()
          return
        }
        applyViewState({
          ...viewRef.current,
          personalProjectOrder: newerPersonalProjectOrder(
            viewRef.current.personalProjectOrder,
            result.value.personalProjectOrder
          )
        })
      } catch {
        refused()
      }
    },
    [
      client,
      supportsPersonalProjectOrder,
      state.servedProjectSections,
      args.projectCatalog,
      applyViewState,
      refused
    ]
  )

  return { supportsPersonalProjectOrder, setProjectOrderBy, toggleProjectPin }
}

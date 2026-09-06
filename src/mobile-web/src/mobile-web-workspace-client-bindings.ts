import type { MobileWebWorkspaceRequestClient } from './mobile-web-workspace-request-client'

export function mobileWebWorkspaceClientBindings(client: MobileWebWorkspaceRequestClient) {
  return {
    workspaceSnapshot: client.snapshot.bind(client),
    workspaceActivate: client.activate.bind(client),
    workspaceRepositories: client.repositories.bind(client),
    workspaceUpdate: client.update.bind(client),
    workspaceRemove: client.remove.bind(client),
    workspaceSettingsSnapshot: client.settingsSnapshot.bind(client),
    workspaceSettingsUpdate: client.settingsUpdate.bind(client)
  }
}

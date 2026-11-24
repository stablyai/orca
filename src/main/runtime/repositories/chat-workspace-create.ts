import { join } from 'node:path'
import type { RuntimeStore } from '../construction/runtime-store-contract'
import type { RuntimeRepositoryRegistrationController } from './runtime-repository-registration-controller'

export function createChatWorkspace(
  registration: Pick<RuntimeRepositoryRegistrationController, 'create'>,
  store: Pick<RuntimeStore, 'getProfileStorageDirectory'>,
  name: string,
  displayName: string
): ReturnType<RuntimeRepositoryRegistrationController['create']> {
  if (!/^\d{4}-\d{2}-\d{2}-[a-f0-9]{8}-[a-f0-9-]{27}$/.test(name)) {
    throw new Error('Invalid chat workspace name')
  }
  const root = store.getProfileStorageDirectory?.()
  if (!root) {
    throw new Error('Profile storage is unavailable')
  }
  return registration.create(join(root, 'chats'), name, 'folder', {
    initialName: displayName.trim() || 'New project',
    autoName: true
  })
}

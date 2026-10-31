// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, vi } from 'vitest'
import { installHappyDomSelectionNotificationTasks } from '@n1-dom-setup'
import { registerMappingContracts } from './mapping-contracts'
import { registerReleaseContracts } from './release-contracts'
import { registerFocusContracts } from './focus-contracts'

export function registerRetainedContracts() {
  let disposeSelectionNotifications: (() => void) | null = null
  beforeEach(() => {
    disposeSelectionNotifications = installHappyDomSelectionNotificationTasks(document)
  })
  afterEach(() => {
    disposeSelectionNotifications?.()
    disposeSelectionNotifications = null
    vi.useRealTimers()
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  describe('Find focus with editor-owned selection', () => {
    registerMappingContracts()
    registerReleaseContracts()
    registerFocusContracts()
  })
}

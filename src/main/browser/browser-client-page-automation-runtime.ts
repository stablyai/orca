import type { BrowserClientAutomationMethod } from '../../shared/browser-client-automation-protocol'
import type { AgentBrowserBridge } from './agent-browser-bridge'
import type { BrowserGuestRegistration, BrowserManager } from './browser-manager'
import { BrowserClientPageCommandError } from './browser-client-page-command-failure'
import type { BrowserRoutePageGuestIdentity } from './browser-route-page-authority'

type AutomationPageInput = {
  browserPageId: string
  pageHostGeneration: number
  browserProfileId: string
  method: BrowserClientAutomationMethod
  params: Record<string, unknown>
  registration: BrowserRoutePageGuestIdentity
}

type AutomationPageRetirement = Pick<
  AutomationPageInput,
  'browserPageId' | 'pageHostGeneration' | 'registration'
>

type AutomationRuntimeDependencies = {
  browserManager: Pick<
    BrowserManager,
    'getGuestWebContentsId' | 'registerGuest' | 'unregisterGuest'
  >
  getAgentBrowserBridge(): Pick<AgentBrowserBridge, 'onTabClosed'> | null
  executeRpc(
    method: BrowserClientAutomationMethod,
    params: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<unknown>
}

type AutomationRegistration = {
  pageHostGeneration: number
  webContentsId: number
}

export class BrowserClientPageAutomationRuntime {
  private readonly registrations = new Map<string, AutomationRegistration>()

  constructor(private readonly dependencies: AutomationRuntimeDependencies) {}

  async execute(input: AutomationPageInput, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) {
      throw new BrowserClientPageCommandError('browser_client_page_command_aborted')
    }
    this.requireRegistration(input)
    const { page: _page, worktree: _worktree, ...params } = input.params
    return this.dependencies.executeRpc(
      input.method,
      { ...params, page: input.browserPageId },
      signal
    )
  }

  async retire(input: AutomationPageRetirement): Promise<void> {
    const current = this.registrations.get(input.browserPageId)
    if (
      !current ||
      current.pageHostGeneration !== input.pageHostGeneration ||
      current.webContentsId !== input.registration.webContentsId
    ) {
      return
    }
    const bridge = this.dependencies.getAgentBrowserBridge()
    if (bridge) {
      await bridge.onTabClosed(current.webContentsId)
    }
    if (
      this.dependencies.browserManager.getGuestWebContentsId(input.browserPageId) ===
      current.webContentsId
    ) {
      this.dependencies.browserManager.unregisterGuest(input.browserPageId)
    }
    this.registrations.delete(input.browserPageId)
  }

  private requireRegistration(input: AutomationPageInput): void {
    const current = this.registrations.get(input.browserPageId)
    if (current) {
      if (
        current.pageHostGeneration !== input.pageHostGeneration ||
        current.webContentsId !== input.registration.webContentsId
      ) {
        throw new BrowserClientPageCommandError('browser_client_page_automation_registration_stale')
      }
      return
    }
    const registeredWebContentsId = this.dependencies.browserManager.getGuestWebContentsId(
      input.browserPageId
    )
    if (
      registeredWebContentsId !== null &&
      registeredWebContentsId !== input.registration.webContentsId
    ) {
      throw new BrowserClientPageCommandError('browser_client_page_automation_registration_stale')
    }
    if (registeredWebContentsId === null) {
      const registration: BrowserGuestRegistration = {
        browserPageId: input.browserPageId,
        workspaceId: '',
        worktreeId: '',
        sessionProfileId: input.browserProfileId,
        webContentsId: input.registration.webContentsId,
        rendererWebContentsId: input.registration.rendererWebContentsId
      }
      if (!this.dependencies.browserManager.registerGuest(registration)) {
        throw new BrowserClientPageCommandError(
          'browser_client_page_automation_registration_failed'
        )
      }
    }
    this.registrations.set(input.browserPageId, {
      pageHostGeneration: input.pageHostGeneration,
      webContentsId: input.registration.webContentsId
    })
  }
}

let configuredRuntime: BrowserClientPageAutomationRuntime | null = null

export function configureBrowserClientPageAutomationRuntime(
  dependencies: AutomationRuntimeDependencies
): void {
  configuredRuntime = new BrowserClientPageAutomationRuntime(dependencies)
}

export function executeBrowserClientPageAutomation(
  input: AutomationPageInput,
  signal: AbortSignal
): Promise<unknown> {
  if (!configuredRuntime) {
    return Promise.reject(new Error('browser_client_page_automation_runtime_unavailable'))
  }
  return configuredRuntime.execute(input, signal)
}

export function retireBrowserClientPageAutomation(input: AutomationPageRetirement): Promise<void> {
  return configuredRuntime?.retire(input) ?? Promise.resolve()
}

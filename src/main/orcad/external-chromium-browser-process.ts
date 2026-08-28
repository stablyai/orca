import { z } from 'zod'
import type {
  RuntimeBrowserCommandHost,
  RuntimeBrowserCommands
} from '../runtime/orca-runtime-browser'
import { BrowserError } from '../browser/browser-error'
import {
  ExternalChromiumBrowserSession,
  type ExternalChromiumLaunch
} from './external-chromium-browser-session'
export type { ExternalChromiumLaunch } from './external-chromium-browser-session'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import {
  externalChromiumCommandArguments,
  normalizeExternalChromiumCommandResult
} from './external-chromium-command-arguments'
import {
  externalChromiumSnapshotResult,
  type ExternalChromiumPageRecord as PageRecord
} from './external-chromium-tab-projection'
import { ExternalChromiumTabRegistry } from './external-chromium-tab-registry'
const AgentBrowserSnapshot = z.object({
  refs: z
    .record(z.string(), z.object({ name: z.string().optional(), role: z.string().optional() }))
    .optional(),
  snapshot: z.string().optional()
})

export class ExternalChromiumBrowserProcess {
  private readonly session: ExternalChromiumBrowserSession
  private readonly tabs: ExternalChromiumTabRegistry
  private queue: Promise<void> = Promise.resolve()
  private available = false

  constructor(agentBrowserPath: string, launch: ExternalChromiumLaunch, statePath: string) {
    this.session = new ExternalChromiumBrowserSession(agentBrowserPath, launch, statePath)
    this.tabs = new ExternalChromiumTabRegistry(this.session)
  }

  async start(): Promise<void> {
    this.tabs.initialize(await this.session.start())
    this.available = true
  }

  createCommands(host: RuntimeBrowserCommandHost): RuntimeBrowserCommands {
    return new Proxy({} as RuntimeBrowserCommands, {
      get: (_target, property) => {
        if (property === 'then') {
          return undefined
        }
        if (typeof property !== 'string') {
          return undefined
        }
        return (...args: unknown[]) => this.enqueue(() => this.invoke(host, property, args))
      }
    })
  }
  isAvailable(): boolean {
    return this.available
  }

  async stop(): Promise<void> {
    this.available = false
    await this.enqueue(async () => {
      await this.session.stop()
      this.tabs.clear()
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async invoke(
    host: RuntimeBrowserCommandHost,
    method: string,
    args: unknown[]
  ): Promise<unknown> {
    const params = (args[0] ?? {}) as Record<string, unknown>
    if (method === 'browserTabCreate') {
      return this.tabs.createTab(host, params)
    }
    if (method === 'browserTabList') {
      return this.tabs.listTabs(host, params)
    }
    if (method === 'browserTabShow') {
      return { tab: await this.tabs.describeTab(host, params) }
    }
    if (method === 'browserTabCurrent') {
      return { tab: await this.tabs.currentTab(host, params) }
    }
    if (method === 'browserTabSwitch') {
      return this.tabs.switchTab(host, params)
    }
    if (method === 'browserTabClose') {
      return this.tabs.closeTab(host, params)
    }
    if (
      method.startsWith('browserProfile') ||
      method === 'browserTabSetProfile' ||
      method === 'browserTabProfileClone'
    ) {
      throw new BrowserError(
        'browser_profile_unavailable',
        'Browser profile import and switching require the desktop Electron provider.'
      )
    }
    if (method === 'browserTabProfileShow') {
      const tab = await this.tabs.describeTab(host, params)
      return {
        browserPageId: tab.browserPageId,
        worktreeId: tab.worktreeId,
        profileId: 'default',
        profileLabel: 'Default'
      }
    }
    if (method === 'browserScreencast') {
      throw new BrowserError(
        'browser_screencast_unavailable',
        'This browser provider does not offer screencast.'
      )
    }
    if (method === 'browserProceedCertificate') {
      throw new BrowserError(
        'browser_certificate_trust_unavailable',
        'This browser provider cannot override certificate failures.'
      )
    }

    const page = await this.tabs.resolveTargetPage(host, params)
    await this.session.selectPage(page.agentPageId)
    if (method === 'browserSnapshot') {
      return this.snapshot(page)
    }
    if (method === 'browserScreenshot') {
      return this.session.screenshot(params, false)
    }
    if (method === 'browserFullScreenshot') {
      return this.session.screenshot(params, true)
    }
    if (method === 'browserPdf') {
      return this.session.pdf()
    }
    if (method === 'browserGoto') {
      const url = normalizeBrowserNavigationUrl(String(params.url ?? ''))
      if (!url) {
        throw new BrowserError(
          'invalid_argument',
          `Unsupported browser URL: ${String(params.url ?? '')}`
        )
      }
      return this.session.run(['open', url])
    }
    if (method === 'browserEval') {
      return this.session.run(['eval', String(params.expression ?? '')])
    }
    if (method === 'browserSelectAll') {
      await this.session.run(['focus', String(params.element ?? '')])
      await this.session.run(['press', 'Control+a'])
      return { selected: String(params.element ?? '') }
    }
    if (method === 'browserBack' || method === 'browserForward' || method === 'browserReload') {
      await this.session.run([method.slice('browser'.length).toLowerCase()])
      const tab = await this.tabs.describePage(page)
      return { url: tab.url, title: tab.title }
    }

    const command = externalChromiumCommandArguments(method, params)
    if (!command) {
      throw new BrowserError(
        'browser_command_unavailable',
        `${method} is not supported by this browser provider.`
      )
    }
    const result = await this.session.run(command)
    return normalizeExternalChromiumCommandResult(method, params, result)
  }

  private async snapshot(page: PageRecord): Promise<unknown> {
    const data = AgentBrowserSnapshot.parse(await this.session.run(['snapshot']))
    return externalChromiumSnapshotResult(page, data, await this.tabs.describePage(page))
  }
}
